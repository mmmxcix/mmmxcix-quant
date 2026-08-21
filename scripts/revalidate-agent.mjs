// revalidate-agent.mjs — the daytime half of Cortex.
//
// The night agent finds candidates. This one decides whether they were real.
// It runs every few hours during the day and, for each candidate that has not
// yet been promoted:
//
//   1. re-runs the full gauntlet on FRESHLY fetched candles (the night's bars
//      are hours old; a strategy fitted to yesterday's tape shows up here)
//   2. re-judges against both profiles at the re-validation bar, which is
//      slightly below the discovery bar — see WHY below
//   3. promotes survivors into the matching book automatically
//   4. buries decayed ones with the reason, so the graveyard explains itself
//
// WHY a lower bar on re-validation: the global trial counter only ever grows,
// so the Deflated Sharpe hurdle a candidate faced at discovery is *strictly
// easier* than the one it faces a day later. Re-testing at the identical
// threshold would reject strategies for the sole reason that the agent kept
// working — it would make the system worse at finding things the harder it
// tried. The re-validation bar (prop 95, private 92) absorbs exactly that
// drift and nothing else; a genuinely decayed strategy still fails it.
//
// No manual promotion anywhere in this path. All virtual, not investment advice.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runBacktest, compileStrategy } from "../src/lib/backtest.js";
import { deflatedSharpe } from "../src/lib/validation.js";
import { initPy, compilePyStrategy } from "./pyRunnerNode.mjs";
import { getProfile, judgePooled, PROFILE_IDS } from "../src/lib/profiles.js";
import { loadUniverse } from "./marketdata.mjs";
import { UNIVERSE, byId, costFor } from "../src/lib/markets.js";
import {
  dailyReturnsOf, poolDaily, sharpeDaily, maxDrawdownPctDaily, foldsProfitable,
  pooledProfitFactor, compactSeries,
} from "../src/lib/ensemble.js";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
const RESEARCH_FILE = join(homedir(), ".mmmxcix-research.json");
// Per-market costs — see src/lib/markets.js costFor().
// A candidate must be at least this old before re-validation can promote it —
// one nightly cycle of separation between "found" and "trusted".
const MIN_AGE_MS = +(process.env.LAB_REVALIDATE_MIN_AGE_H || 6) * 3600 * 1000;
// Guard the free LLM tier's neighbour: this agent makes no model calls at all,
// but it does hammer the market APIs, so cap the work per run.
const MAX_PER_RUN = +(process.env.LAB_REVALIDATE_MAX || 8);
// How many legs of a surviving pooled rule reach the paper book (mirrors the
// research agent's LAB_ENSEMBLE_MARKETS so both halves paper the same shape).
const ENSEMBLE_MARKETS = Math.max(1, +(process.env.LAB_ENSEMBLE_MARKETS || 2));

if (!TOKEN) { console.error("LAB_TOKEN is not set."); process.exit(1); }

function loadResearch() {
  try { return JSON.parse(readFileSync(RESEARCH_FILE, "utf8")); } catch {
    return { seen: [], attempts: 0, graveyard: [], candidates: [], papersRead: 0 };
  }
}
function saveResearch(st) {
  try { writeFileSync(RESEARCH_FILE, JSON.stringify(st)); } catch (e) { console.error("state save failed:", e.message); }
}

const api = (path, init) => fetch(`${SITE}/api/lab${path}`, init);

// Language-aware compile: Python candidates (Cortex writes these) go through
// Pyodide, JS through the classic compiler. A drop-in for compileStrategy so the
// re-validation runs the SAME code path — and the same language — as discovery.
function compileFor(code, lang) {
  return lang === "python" ? compilePyStrategy(code) : compileStrategy(code);
}

/**
 * Re-run the rule on fresh data across the SAME pooled object it was accepted
 * on (Tier-1, docs/CORTEX_BENCHMARK.md): every leg re-backtested, daily
 * returns re-pooled, and the pooled bars re-judged at slightly softer
 * re-validation levels (pooled-Sharpe haircut + minDsrOnRevalidate — same WHY
 * as always: the trial counter only grows, so the identical threshold would
 * punish the agent for having kept working). No per-market walls.
 */
const REVAL_MIN_SHARPE = +(process.env.LAB_REVALIDATE_MIN_SHARPE || 0.25);
function revalidate(candidate, datasetsById, globalTrials) {
  const code = candidate.code;
  const lang = candidate.language === "python" ? "python" : "js";
  try { compileFor(code, lang); } catch (e) { return { pass: false, reason: `compile: ${e.message.slice(0, 70)}` }; }

  const claimed = (candidate.pooledMarkets || candidate.markets || []).filter((id) => datasetsById[id]);
  if (!claimed.length) return { pass: false, reason: "none of its markets could be loaded" };

  const byMarket = {};
  const ran = [];
  for (const mid of claimed) {
    const { candles, market } = datasetsById[mid];
    const feeBps = costFor(market);
    let res;
    try {
      res = runBacktest({ candles, signalFn: compileFor(code, lang), initialCapital: 10000, feeBps });
    } catch (e) {
      byMarket[mid] = { rejected: `runtime: ${e.message.slice(0, 40)}` };
      continue;
    }
    if (res.warnings.length) { byMarket[mid] = { rejected: `error: ${res.warnings[0].slice(0, 50)}` }; continue; }
    const m = res.metrics;
    byMarket[mid] = {
      ret: +m.totalReturnPct.toFixed(1), pf: +m.profitFactor.toFixed(2),
      dd: +m.maxDrawdownPct.toFixed(1), n: m.tradeCount, sharpe: +(m.sharpe ?? 0).toFixed(2),
    };
    ran.push({ mid, candles, feeBps, m, equity: res.equity, trades: res.trades });
  }
  if (!ran.length) return { pass: false, reason: "every leg errored on fresh data", byMarket };

  const pooledSeries = poolDaily(ran.map((r) => dailyReturnsOf(r.equity)));
  const spanYears = Math.max(0.1, ...ran.map((r) => r.m.spanYears || 0));
  const pooledTrades = ran.reduce((s, r) => s + r.m.tradeCount, 0);
  const pooled = {
    sharpe: sharpeDaily(pooledSeries.returns),
    pf: pooledProfitFactor(ran.map((r) => r.trades)),
    ddPct: maxDrawdownPctDaily(pooledSeries.returns),
    trades: pooledTrades,
    tradesPerYear: pooledTrades / spanYears,
    obsDays: pooledSeries.returns.length,
  };

  if (pooled.sharpe < REVAL_MIN_SHARPE) {
    return { pass: false, reason: `pooled Sharpe decayed to ${pooled.sharpe.toFixed(2)} (< ${REVAL_MIN_SHARPE}) across ${ran.length} legs`, byMarket };
  }

  // Execution-timing robustness must still hold on fresh tape.
  const delayed = [];
  for (const r of ran) {
    try {
      const inner = compileFor(code, lang);
      let prev = "flat";
      const res = runBacktest({
        candles: r.candles,
        signalFn: (ctx) => { const s = inner(ctx); const out = prev; prev = s; return out; },
        initialCapital: 10000, feeBps: r.feeBps,
      });
      if (!res.warnings.length) delayed.push(dailyReturnsOf(res.equity));
    } catch { /* a leg that errors delayed contributes nothing */ }
  }
  const delSharpe = sharpeDaily(poolDaily(delayed).returns);
  if (delSharpe < Math.max(0.1, pooled.sharpe * 0.5)) {
    return { pass: false, reason: `timing-fragile on fresh data (pooled Sharpe ${pooled.sharpe.toFixed(2)}→${delSharpe.toFixed(2)} delayed)`, byMarket };
  }

  const kf = foldsProfitable(pooledSeries.returns, 5);
  if (kf.profitable < Math.ceil(kf.total * 0.6)) {
    return { pass: false, reason: `k-fold decayed (${kf.profitable}/${kf.total} pooled folds)`, byMarket };
  }

  const dsrRaw = deflatedSharpe(pooledSeries.returns, globalTrials);
  const dsrPct = dsrRaw ? dsrRaw.dsr * 100 : 0;

  // Structural pooled bars at the profile's normal level (minus the small
  // Sharpe haircut already applied above); only DSR relaxes to the
  // re-validation threshold.
  const qualified = [];
  const reasons = {};
  for (const pid of PROFILE_IDS) {
    const prof = getProfile(pid);
    const structural = judgePooled({ profileId: pid, pooled, overrides: { minSharpe: REVAL_MIN_SHARPE } });
    if (!structural.pass) { reasons[pid] = structural.reason; continue; }
    if (dsrPct < prof.promotion.minDsrOnRevalidate) {
      reasons[pid] = `DSR ${dsrPct.toFixed(1)}% < ${prof.promotion.minDsrOnRevalidate}%`;
      continue;
    }
    qualified.push(pid);
  }
  if (!qualified.length) {
    return { pass: false, reason: reasons.private || reasons.prop || "decayed", byMarket };
  }

  const active = ran.filter((r) => r.m.tradeCount >= 20 && (r.m.sharpe ?? 0) > 0)
    .sort((a, b) => (b.m.sharpe ?? 0) - (a.m.sharpe ?? 0));
  for (const r of active) byMarket[r.mid] = { ...byMarket[r.mid], earns: true };
  const markets = active.length ? active.map((r) => r.mid) : ran.map((r) => r.mid);
  return {
    pass: true, byMarket, markets, bestMarket: markets[0],
    dsr: +dsrPct.toFixed(1), qualified,
    pooled: {
      sharpe: +pooled.sharpe.toFixed(2), pf: +pooled.pf.toFixed(2),
      ddPct: +pooled.ddPct.toFixed(1), trades: pooled.trades,
      obsDays: pooled.obsDays, dsr: +dsrPct.toFixed(1),
    },
    pooledDaily: compactSeries(pooledSeries),
    pooledMarkets: ran.map((r) => r.mid),
  };
}

// ── main ────────────────────────────────────────────────────────────────────
const st = loadResearch();

const [candRes, stratRes, stateRes] = await Promise.all([
  api("?what=candidates", { headers: { "x-lab-token": TOKEN } }).then((r) => r.json()).catch(() => ({})),
  api("?what=strategies", { headers: { "x-lab-token": TOKEN } }).then((r) => r.json()).catch(() => ({})),
  api("", { headers: { "x-lab-token": TOKEN } }).then((r) => r.json()).catch(() => ({})),
]);

const candidates = candRes?.candidates?.items || [];
const live = stratRes?.strategies?.items || [];
// A candidate already trading (in either book) is the paper agent's problem now.
const livePrefixes = new Set(live.map((s) => String(s.candidateId || s.id).replace(/_(prop|private)$/, "")));

const now = Date.now();
const due = candidates
  .filter((c) => c && c.code && c.id)
  .filter((c) => !livePrefixes.has(c.id))
  .filter((c) => now - (c.foundAt || 0) >= MIN_AGE_MS)
  .filter((c) => now - (c.lastRevalidatedAt || 0) >= 6 * 3600 * 1000)
  .slice(0, MAX_PER_RUN);

console.log(`revalidate: ${candidates.length} candidates, ${live.length} live, ${due.length} due this run`);

if (!due.length) {
  console.log("nothing due — exiting clean");
  process.exit(0);
}

// Boot Python once if any due candidate is Python — revalidate() then runs their
// signals(df) synchronously through this one Pyodide instance.
if (due.some((c) => c.language === "python")) {
  const t = Date.now();
  await initPy((m) => console.log(`  ${m}`));
  console.log(`Python runtime ready in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

// Load only the markets the due candidates actually claim — no point pulling
// EUR/USD if nothing under review was ever validated on it.
const neededIds = new Set(due.flatMap((c) => c.markets || []));
const needed = UNIVERSE.filter((m) => neededIds.has(m.id));
const datasets = await loadUniverse(needed.length ? needed : UNIVERSE.filter((m) => m.core));
const datasetsById = Object.fromEntries(datasets.map((d) => [d.name, d]));

const toPromote = [];
const survivors = [];
const decayed = [];

for (const c of due) {
  const verdict = revalidate(c, datasetsById, Math.max(1, st.attempts || 1));
  if (verdict.pass) {
    survivors.push({
      ...c, lastRevalidatedAt: now, revalidatedDsr: verdict.dsr,
      profiles: verdict.qualified, markets: verdict.markets,
      pooled: verdict.pooled, pooledDaily: verdict.pooledDaily, pooledMarkets: verdict.pooledMarkets,
      byMarket: { ...(c.byMarket || {}), ...verdict.byMarket },
    });
    const p = verdict.pooled;
    console.log(
      `✓ holds up: ${String(c.name).slice(0, 40)} — pooled Sharpe ${p.sharpe} · PF ${p.pf} · dd ${p.ddPct}% ` +
      `· n=${p.trades} over ${verdict.pooledMarkets.length} legs (DSR ${c.dsr}% → ${verdict.dsr}%)`
    );
    // Paper the strongest legs of the pooled object, one entry per
    // (profile × leg) — the profiles are earned POOLED, so they apply to every
    // leg of the same rule rather than being re-derived per market.
    for (const mid of (verdict.markets || []).slice(0, ENSEMBLE_MARKETS)) {
      const m = byId(mid);
      if (!m) continue;
      for (const pid of verdict.qualified) {
        toPromote.push({
          id: `${c.id}_${pid}_${mid}`, name: `🤖 ${c.name} · ${m.label}`,
          mode: "code", code: c.code, language: c.language,
          market: m.asset === "crypto" ? "crypto" : "stock",
          symbol: m.symbol, interval: m.interval,
          feeBps: costFor(m), positionPct: 100,
          volTarget: true, // GARCH vol-targeted sizing — cuts drawdown by default
          dsr: verdict.dsr, paper: c.paper,
          profile: pid, candidateId: c.id, marketId: mid, promotedBy: "revalidate",
          ensembleRule: c.id,
          pooled: verdict.pooled, // the leg's judge (see progressEntry)
          expect: {
            retPct: verdict.byMarket[mid]?.ret ?? null,
            ddPct: verdict.byMarket[mid]?.dd ?? null,
            pf: verdict.byMarket[mid]?.pf ?? null,
            n: verdict.byMarket[mid]?.n ?? null,
          },
        });
      }
    }
  } else {
    decayed.push({ id: c.id, name: c.name, reason: verdict.reason });
    console.log(`✗ decayed: ${String(c.name).slice(0, 48)} — ${verdict.reason}`);
    // Bury WITH the code and a fresh improve budget: a strategy that decayed on a
    // quality bar is exactly the improve loop's raw material — a code-less
    // tombstone would be a dead end. Replace a same-title corpse instead of
    // stacking a duplicate per pass (the old behaviour flooded the 200-cap
    // graveyard with 8 new tombstones every run and evicted the improvable ones).
    const corpse = {
      title: String(c.name).slice(0, 70), reason: `revalidate: ${verdict.reason}`,
      source: c.source, topics: c.topics, code: c.code, language: c.language,
      link: c.paper, improveTries: 0, at: now,
    };
    st.graveyard = [corpse, ...(st.graveyard || []).filter((g) => g.title !== corpse.title)].slice(0, 200);
  }
}

// Drop decayed candidates from the local store so they are not retried forever.
const decayedIds = new Set(decayed.map((d) => d.id));
st.candidates = (st.candidates || [])
  .filter((c) => !decayedIds.has(c.id))
  .map((c) => survivors.find((s) => s.id === c.id) || c);

// Keep the ENSEMBLE book honest: a rule that decayed on fresh data leaves the
// book (and its paper legs are retired below), and a survivor's member entry
// gets today's pooled series so the next admission's correlation/marginal
// checks compare against current behaviour, not last month's.
if (st.ensemble?.members?.length) {
  const before = st.ensemble.members.length;
  st.ensemble.members = st.ensemble.members
    .filter((m) => !decayedIds.has(m.candId))
    .map((m) => {
      const s = survivors.find((x) => x.id === m.candId);
      return s ? { ...m, sharpe: s.pooled?.sharpe ?? m.sharpe, profiles: s.profiles || m.profiles, pooledDaily: s.pooledDaily || m.pooledDaily } : m;
    });
  const dropped = before - st.ensemble.members.length;
  if (dropped) console.log(`ensemble: ${dropped} decayed rule(s) left the book — ${st.ensemble.members.length} remain`);
}
saveResearch(st);

// …and from the SITE store, or they come back as "due" on the next pass and get
// re-decayed forever (the zombie loop this agent was stuck in until Aug 2026).
// Stale code-less candidates (an early schema carried none) can never be
// re-validated OR traded, so they are removed once they are a week old.
const removeIds = [
  ...decayed.map((d) => d.id),
  ...candidates.filter((c) => c && c.id && !c.code && now - (c.foundAt || 0) > 7 * 864e5).map((c) => c.id),
];
// A decayed rule must also stop TRADING: retire its paper legs, or the book
// keeps compounding a hypothesis this pass just disproved.
if (decayed.length) {
  try {
    const r = await api("", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, retire: { ids: decayed.map((d) => d.id) } }),
    });
    const o = await r.json().catch(() => ({}));
    if (o.retired) console.log(`retired ${o.retired} paper leg(s) of decayed rule(s)`);
  } catch (e) { console.error(`retire push failed: ${e.message}`); }
}
if (removeIds.length) {
  try {
    const r = await api("", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, candidatesRemove: removeIds }),
    });
    const o = await r.json().catch(() => ({}));
    console.log(`site candidates pruned: ${o.removed ?? "?"} removed, ${o.remaining ?? "?"} remain`);
  } catch (e) { console.error(`candidate prune failed: ${e.message}`); }
}

// Push survivors back so the site's candidate list carries the fresh verdict.
// pooledDaily stays LOCAL (thousands of floats — the KV value budget can't
// afford it and the card doesn't need it); it lives in the research state file.
if (survivors.length) {
  try {
    const r = await api("", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, candidates: survivors.map(({ pooledDaily, ...rest }) => rest) }),
    });
    console.log(`candidates refreshed: ${(await r.json().catch(() => ({}))).stored ?? "?"} stored`);
  } catch (e) { console.error(`candidate refresh failed: ${e.message}`); }
}

// Promotion, gated per profile by the live RiskGate — same rule as the night agent.
const rgAll = stateRes?.state?.riskgate;
const holdFor = (pid) => {
  const rg = rgAll?.byProfile?.[pid] || (pid === "private" ? rgAll : null);
  if (!rg) return "";
  const prof = getProfile(pid);
  const openN = rg.activeLimits?.openPositions ?? 0;
  const maxN = rg.rules?.maxSimultaneousPositions ?? prof.risk.maxSimultaneousPositions;
  const dd = rg.activeLimits?.combinedDrawdownPct ?? 0;
  const maxDd = rg.rules?.maxCombinedDrawdownPct ?? prof.risk.maxCombinedDrawdownPct;
  if (openN >= maxN) return `book full (${openN}/${maxN})`;
  if (dd > maxDd) return `drawdown ${dd}% > ${maxDd}%`;
  return "";
};
const allowed = [], held = [];
for (const p of toPromote) {
  const h = holdFor(p.profile);
  if (h) held.push(`${p.profile}: ${h}`); else allowed.push(p);
}

if (allowed.length) {
  try {
    const r = await api("", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, promote: allowed }),
    });
    const o = await r.json().catch(() => ({}));
    console.log(`🤖 promoted ${allowed.length} → ${JSON.stringify(o.byProfile || {})} (caps ${JSON.stringify(o.caps || {})})`);
  } catch (e) { console.error(`promotion push failed: ${e.message}`); }
}
if (held.length) console.log(`🚦 held by RiskGate — ${[...new Set(held)].join("; ")}`);

// Report into lab:state so the Coach page shows the daytime half is alive.
const state = {
  ...(stateRes?.state || {}),
  revalidate: {
    lastRun: now,
    checked: due.length,
    survived: survivors.length,
    decayed: decayed.length,
    promoted: allowed.length,
    held: [...new Set(held)],
    lastDecayed: decayed.slice(0, 3).map((d) => ({ title: String(d.name).slice(0, 70), reason: d.reason })),
  },
};
let pushOk = false;
try {
  const push = await api("", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, state }),
  });
  pushOk = !!(await push.json().catch(() => ({}))).ok;
} catch (e) { console.error(`state push failed: ${e.message}`); }
console.log(
  `revalidate done: ${survivors.length} held up, ${decayed.length} decayed, ${allowed.length} promoted → ` +
  `push ${pushOk ? "ok" : "FAILED"}`
);
