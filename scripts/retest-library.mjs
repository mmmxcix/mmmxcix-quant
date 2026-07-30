// retest-library.mjs — Cortex's auto-progression pass over the strategy library.
//
// Reads the shared D1 library (/api/library, machine-token auth), re-runs each
// non-buried strategy's backtest on fresh data, and lets progression.js decide
// where it belongs now: advance up the pipeline, sideline to "improve" on a
// time-window flaw, or bury it. Writes the new stage back so the Registry windows
// always reflect reality. Scheduled by agent-daemon.mjs.
//
// Publishing a paper strategy to the LIVE agent stays a manual click — this only
// moves strategies between library STAGES, never trades anything.

import { runBacktest, compileStrategy } from "../src/lib/backtest.js";
import { compilePyStrategy, initPy } from "./pyRunnerNode.mjs";
import { BUILT_IN_STRATEGIES } from "../src/lib/strategies.js";
import { windowProfile } from "../src/lib/windowProfile.js";
import { progressEntry } from "../src/lib/progression.js";
import { loadMarket } from "./marketdata.mjs";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;

// Quality bar for advancement — tunable via env, defaults matching the research
// agent's "a quant would find this attractive" standard.
const BAR = {
  minSharpe: +(process.env.LAB_LIB_MIN_SHARPE || 0.8),
  minPF: +(process.env.LAB_LIB_MIN_PF || 1.15),
  minTrades: +(process.env.LAB_LIB_MIN_TRADES || 30),
};

/** Rebuild a runnable signal function from a stored entry (builder or code). */
function signalFor(entry) {
  if (entry.mode === "builder" && entry.strategyId) {
    const s = BUILT_IN_STRATEGIES.find((x) => x.id === entry.strategyId);
    return s ? s.build(entry.params || {}) : null;
  }
  if (entry.code) return entry.language === "python" ? compilePyStrategy(entry.code) : compileStrategy(entry.code);
  return null;
}

/** Load candles for the market/window the entry was defined on. */
async function candlesFor(entry) {
  const asset = entry.market === "crypto" ? "crypto" : "stock";
  const ds = await loadMarket({ id: entry.symbol, asset, symbol: entry.symbol, interval: entry.interval || "1d", range: entry.range || "5y", bars: 6000 });
  return ds?.candles || null;
}

export async function retestLibrary() {
  if (!TOKEN) { console.error("LAB_TOKEN is not set."); return []; }
  let entries = [];
  try {
    const r = await fetch(`${SITE}/api/library`, { headers: { "x-lab-token": TOKEN } });
    const j = await r.json();
    entries = Array.isArray(j.entries) ? j.entries : [];
  } catch (e) { console.error(`[${new Date().toISOString()}] library fetch failed: ${e.message}`); return []; }
  if (!entries.length) { console.log(`[${new Date().toISOString()}] library empty — nothing to re-test`); return []; }

  if (entries.some((e) => e.language === "python")) { try { await initPy(); } catch { /* JS-only fallback */ } }

  const moves = [];
  for (const entry of entries) {
    if (entry.status === "graveyard") continue; // leave the dead buried
    try {
      const fn = signalFor(entry);
      if (!fn) continue;
      const candles = await candlesFor(entry);
      if (!candles) continue;
      const res = runBacktest({ candles, signalFn: fn, initialCapital: 10000, feeBps: entry.feeBps ?? 10, positionPct: entry.positionPct ?? 100 });
      const retest = { metrics: res.metrics, windowProfile: windowProfile(res.equity, { segments: 2 }) };
      const d = progressEntry(entry, retest, BAR);
      // Always refresh the stored metrics/profile; only write when something moved.
      if (d.changed || true) {
        entry.metrics = res.metrics;
        entry.windowProfile = retest.windowProfile;
        entry.status = d.status;
        entry.failureReason = d.failureReason;
        if (d.changed) moves.push({ name: entry.name, to: d.status, why: d.reason });
        await fetch(`${SITE}/api/library`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: TOKEN, upsert: entry }),
        });
      }
    } catch (e) { console.error(`  ${(entry.name || entry.id || "?").slice(0, 40)}: ${String(e.message).slice(0, 80)}`); }
  }
  console.log(`[${new Date().toISOString()}] retest: ${entries.length} entries · ${moves.length} moved${moves.length ? " — " + moves.map((m) => `${m.name}→${m.to}(${m.why})`).join(", ") : ""}`);
  return moves;
}

// The daemon fork()s this file as the entry point → run the pass and exit.
if (process.argv[1] && /retest-library\.mjs$/.test(process.argv[1].replace(/\\/g, "/"))) {
  retestLibrary().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
