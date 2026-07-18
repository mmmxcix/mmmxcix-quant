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
import { getProfile, judgeMetrics, PROFILE_IDS } from "../src/lib/profiles.js";
import { validationDatasets } from "./marketdata.mjs";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
const RESEARCH_FILE = join(homedir(), ".mmmxcix-research.json");
const FEE_BPS = 10;
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

/**
 * Re-run the structural gauntlet on fresh data. Same checks as discovery, but
 * judged at the profile's re-validation threshold.
 */
function revalidate(code, datasets, globalTrials) {
  try { compileStrategy(code); } catch (e) { return { pass: false, reason: `compile: ${e.message.slice(0, 70)}` }; }

  const perSet = [];
  for (const { name, candles } of datasets) {
    let res;
    try {
      res = runBacktest({ candles, signalFn: compileStrategy(code), initialCapital: 10000, feeBps: FEE_BPS });
    } catch (e) {
      return { pass: false, reason: `runtime(${name}): ${e.message.slice(0, 55)}` };
    }
    if (res.warnings.length) return { pass: false, reason: `error (${name}): ${res.warnings[0].slice(0, 70)}` };
    perSet.push({ name, m: res.metrics, equity: res.equity });
  }

  const primary = datasets[0];
  const kf = kFoldCode({ candles: primary.candles, makeSignalFn: () => compileStrategy(code), feeBps: FEE_BPS });
  if (!kf || kf.verdict !== "pass") {
    return { pass: false, reason: `k-fold decayed (${kf ? kf.profitableFolds + "/" + kf.totalFolds : "n/a"})` };
  }
  const nz = noiseTest({ candles: primary.candles, makeSignalFn: () => compileStrategy(code), runs: 15, feeBps: FEE_BPS });
  if (!nz || nz.verdict !== "pass") {
    return { pass: false, reason: `noise decayed (median ${nz ? nz.medianReturnPct.toFixed(0) : "?"}%)` };
  }

  const dsrRaw = deflatedSharpe(equityReturns(perSet[0].equity), Math.max(1, globalTrials));
  const dsrPct = dsrRaw ? dsrRaw.dsr * 100 : 0;

  // Structural metrics are judged at the profile's normal bars; only the DSR
  // threshold is relaxed to the re-validation level (see the WHY at the top).
  const qualified = [];
  const reasons = {};
  for (const pid of PROFILE_IDS) {
    const prof = getProfile(pid);
    const structural = judgeMetrics({ profileId: pid, perSet }); // no dsr here
    if (!structural.pass) { reasons[pid] = structural.reason; continue; }
    if (dsrPct < prof.promotion.minDsrOnRevalidate) {
      reasons[pid] = `DSR ${dsrPct.toFixed(1)}% < ${prof.promotion.minDsrOnRevalidate}% (revalidate)`;
      continue;
    }
    qualified.push(pid);
  }

  const metrics = Object.fromEntries(perSet.map((s) => [s.name, {
    ret: +s.m.totalReturnPct.toFixed(1), pf: +s.m.profitFactor.toFixed(2),
    dd: +s.m.maxDrawdownPct.toFixed(1), n: s.m.tradeCount,
  }]));

  if (!qualified.length) {
    return { pass: false, reason: reasons.private || reasons.prop || "failed all profiles", metrics, dsr: +dsrPct.toFixed(1) };
  }
  return { pass: true, qualified, reasons, metrics, dsr: +dsrPct.toFixed(1) };
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

const datasets = await validationDatasets();
const toPromote = [];
const survivors = [];
const decayed = [];

for (const c of due) {
  const verdict = revalidate(c.code, datasets, Math.max(1, st.attempts || 1));
  if (verdict.pass) {
    survivors.push({ ...c, lastRevalidatedAt: now, revalidatedDsr: verdict.dsr, profiles: verdict.qualified });
    console.log(`✓ holds up: ${String(c.name).slice(0, 48)} (DSR ${c.dsr}% → ${verdict.dsr}%) → ${verdict.qualified.join(", ")}`);
    for (const pid of verdict.qualified) {
      toPromote.push({
        id: `${c.id}_${pid}`, name: `🤖 ${c.name}`, mode: "code", code: c.code,
        market: "crypto", symbol: "BTCUSDT", interval: "4h",
        feeBps: FEE_BPS, positionPct: 100, dsr: verdict.dsr, paper: c.paper,
        profile: pid, candidateId: c.id, promotedBy: "revalidate",
      });
    }
  } else {
    decayed.push({ id: c.id, name: c.name, reason: verdict.reason });
    console.log(`✗ decayed: ${String(c.name).slice(0, 48)} — ${verdict.reason}`);
    st.graveyard = [{
      title: String(c.name).slice(0, 70), reason: `revalidate: ${verdict.reason}`,
      source: c.source, topics: c.topics, at: now,
    }, ...(st.graveyard || [])].slice(0, 200);
  }
}

// Drop decayed candidates from the local store so they are not retried forever.
const decayedIds = new Set(decayed.map((d) => d.id));
st.candidates = (st.candidates || [])
  .filter((c) => !decayedIds.has(c.id))
  .map((c) => survivors.find((s) => s.id === c.id) || c);
saveResearch(st);

// Push survivors back so the site's candidate list carries the fresh verdict.
if (survivors.length) {
  const r = await api("", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, candidates: survivors }),
  });
  console.log(`candidates refreshed: ${(await r.json().catch(() => ({}))).stored ?? "?"} stored`);
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
  const r = await api("", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, promote: allowed }),
  });
  const o = await r.json().catch(() => ({}));
  console.log(`🤖 promoted ${allowed.length} → ${JSON.stringify(o.byProfile || {})} (caps ${JSON.stringify(o.caps || {})})`);
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
const push = await api("", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: TOKEN, state }),
});
console.log(
  `revalidate done: ${survivors.length} held up, ${decayed.length} decayed, ${allowed.length} promoted → ` +
  `push ${(await push.json().catch(() => ({}))).ok ? "ok" : "FAILED"}`
);
