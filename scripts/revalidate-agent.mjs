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
import { kFoldCode, noiseTest, deflatedSharpe, equityReturns } from "../src/lib/validation.js";
import { initPy, compilePyStrategy } from "./pyRunnerNode.mjs";
import { getProfile, judgeMetrics, PROFILE_IDS } from "../src/lib/profiles.js";
import { loadUniverse } from "./marketdata.mjs";
import { UNIVERSE, byId, costFor, effectiveTrials } from "../src/lib/markets.js";

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

// Sharpe with the whole decision delayed one bar — the execution-robustness
// probe (a real edge barely changes; a timing artifact collapses). 0 on failure.
function delayedSharpe(code, candles, feeBps, lang) {
  try {
    const inner = compileFor(code, lang);
    let prev = "flat";
    const res = runBacktest({ candles, signalFn: (ctx) => { const s = inner(ctx); const out = prev; prev = s; return out; }, initialCapital: 10000, feeBps });
    return res.warnings.length ? 0 : (res.metrics.sharpe ?? 0);
  } catch { return 0; }
}

/**
 * Re-run the gauntlet on fresh data, ONLY on the markets this candidate was
 * originally validated for.
 *
 * Re-testing the whole universe here would be wrong twice over: it would cost
 * ten times the data for no new information, and a strategy that newly happens
 * to work on a venue it was never accepted for is a fresh discovery, not a
 * re-validation — it belongs to the night agent's trial accounting, not this
 * one's. So the question asked here is narrow and correct: *does it still work
 * where it claimed to?*
 */
function revalidate(candidate, datasetsById, globalTrials) {
  const code = candidate.code;
  const lang = candidate.language === "python" ? "python" : "js";
  try { compileFor(code, lang); } catch (e) { return { pass: false, reason: `compile: ${e.message.slice(0, 70)}` }; }

  const claimed = (candidate.markets || []).filter((id) => datasetsById[id]);
  if (!claimed.length) return { pass: false, reason: "none of its markets could be loaded" };

  // Same windowed + clustered accounting as discovery (see markets.js), so a
  // candidate is not re-judged against a harsher bar than it was found under.
  const trials = effectiveTrials(globalTrials, claimed.map((id) => byId(id)?.asset).filter(Boolean));
  const byMarket = {};
  const stillWorking = [];
  const qualified = new Set();
  const reasons = {};

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
    const row = {
      ret: +m.totalReturnPct.toFixed(1), pf: +m.profitFactor.toFixed(2),
      dd: +m.maxDrawdownPct.toFixed(1), n: m.tradeCount,
    };

    // Beats buy & hold risk-adjusted, and survives a 1-bar execution delay — the
    // two checks that stop optimistic backtests reaching the paper book (a
    // strategy that loses to holding, or whose edge is a timing artifact, is
    // what looks great here but goes negative on a broker's fills).
    if ((m.sharpe ?? 0) <= (m.buyHoldSharpe ?? 0)) {
      byMarket[mid] = { ...row, rejected: `loses to buy&hold (Sh ${(m.sharpe ?? 0).toFixed(2)} ≤ ${(m.buyHoldSharpe ?? 0).toFixed(2)})` };
      reasons[mid] = byMarket[mid].rejected; continue;
    }
    const delSh = delayedSharpe(code, candles, feeBps, lang);
    if (delSh < Math.max(0.1, (m.sharpe ?? 0) * 0.5)) {
      byMarket[mid] = { ...row, rejected: `timing-fragile (Sh ${(m.sharpe ?? 0).toFixed(2)}→${delSh.toFixed(2)} on 1-bar delay)` };
      reasons[mid] = byMarket[mid].rejected; continue;
    }

    const kf = kFoldCode({ candles, makeSignalFn: () => compileFor(code, lang), feeBps });
    if (!kf || kf.verdict !== "pass") {
      byMarket[mid] = { ...row, rejected: `k-fold decayed (${kf ? kf.profitableFolds + "/" + kf.totalFolds : "n/a"})` };
      reasons[mid] = byMarket[mid].rejected;
      continue;
    }
    const nz = noiseTest({ candles, makeSignalFn: () => compileFor(code, lang), runs: 15, feeBps });
    if (!nz || nz.verdict !== "pass") {
      byMarket[mid] = { ...row, rejected: `noise decayed (median ${nz ? nz.medianReturnPct.toFixed(0) : "?"}%)` };
      reasons[mid] = byMarket[mid].rejected;
      continue;
    }

    const dsrRaw = deflatedSharpe(equityReturns(res.equity), trials);
    const dsrPct = dsrRaw ? dsrRaw.dsr * 100 : 0;

    // Structural bars stay at the profile's normal level; only the DSR
    // threshold is relaxed to the re-validation level (see the WHY at the top).
    const marketProfiles = [];
    for (const pid of PROFILE_IDS) {
      const prof = getProfile(pid);
      const structural = judgeMetrics({ profileId: pid, perSet: [{ name: mid, m }] }); // no dsr here
      if (!structural.pass) { reasons[`${mid}/${pid}`] = structural.reason; continue; }
      if (dsrPct < prof.promotion.minDsrOnRevalidate) {
        reasons[`${mid}/${pid}`] = `DSR ${dsrPct.toFixed(1)}% < ${prof.promotion.minDsrOnRevalidate}%`;
        continue;
      }
      marketProfiles.push(pid);
      qualified.add(pid);
    }

    byMarket[mid] = { ...row, dsr: +dsrPct.toFixed(1), profiles: marketProfiles };
    if (marketProfiles.length) stillWorking.push(mid);
  }

  if (!stillWorking.length) {
    return { pass: false, reason: Object.values(reasons)[0] || "decayed everywhere", byMarket };
  }
  // Same pooled sample floor as the research gauntlet: surviving markets must
  // still add up to a defensible TOTAL sample, not just each clear their own bar.
  const MIN_POOLED_TRADES = +(process.env.LAB_MIN_POOLED_TRADES || 300);
  const pooledTrades = stillWorking.reduce((s, mid) => s + (byMarket[mid].n ?? 0), 0);
  if (pooledTrades < MIN_POOLED_TRADES) {
    return { pass: false, reason: `pooled sample too thin on re-validation (${pooledTrades} trades across ${stillWorking.length} market(s), need ≥${MIN_POOLED_TRADES} total)`, byMarket };
  }
  const best = stillWorking.slice().sort((a, b) => (byMarket[b].dsr ?? 0) - (byMarket[a].dsr ?? 0))[0];
  return {
    pass: true, byMarket, markets: stillWorking, bestMarket: best,
    dsr: byMarket[best].dsr, qualified: [...qualified],
    lostMarkets: claimed.filter((m) => !stillWorking.includes(m)),
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
      byMarket: { ...(c.byMarket || {}), ...verdict.byMarket },
    });
    const lost = verdict.lostMarkets?.length ? ` (lost ${verdict.lostMarkets.join(", ")})` : "";
    console.log(`✓ holds up: ${String(c.name).slice(0, 44)} (DSR ${c.dsr}% → ${verdict.dsr}% on ${verdict.bestMarket})${lost}`);
    for (const mid of verdict.markets) {
      const m = byId(mid);
      if (!m) continue;
      for (const pid of verdict.byMarket[mid]?.profiles || []) {
        toPromote.push({
          id: `${c.id}_${pid}_${mid}`, name: `🤖 ${c.name} · ${m.label}`,
          mode: "code", code: c.code, language: c.language,
          market: m.asset === "crypto" ? "crypto" : "stock",
          symbol: m.symbol, interval: m.interval,
          feeBps: costFor(m), positionPct: 100,
          volTarget: true, // GARCH vol-targeted sizing — cuts drawdown by default
          dsr: verdict.byMarket[mid].dsr, paper: c.paper,
          profile: pid, candidateId: c.id, marketId: mid, promotedBy: "revalidate",
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
saveResearch(st);

// …and from the SITE store, or they come back as "due" on the next pass and get
// re-decayed forever (the zombie loop this agent was stuck in until Aug 2026).
// Stale code-less candidates (an early schema carried none) can never be
// re-validated OR traded, so they are removed once they are a week old.
const removeIds = [
  ...decayed.map((d) => d.id),
  ...candidates.filter((c) => c && c.id && !c.code && now - (c.foundAt || 0) > 7 * 864e5).map((c) => c.id),
];
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
if (survivors.length) {
  try {
    const r = await api("", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, candidates: survivors }),
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
