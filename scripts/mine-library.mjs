// mine-library.mjs — Cortex mines the LIBRARY, not just raw price anomalies.
//
// For each promising builder strategy already in the library, it probes the
// immediate parameter neighbourhood (one param nudged at a time) on that
// strategy's own market, and if a neighbour genuinely beats the parent (higher
// Sharpe, drawdown not materially worse, still enough trades), it files that
// variant as a NEW library entry at Factory — the auto-progression engine then
// re-tests and advances it like anything else. This is the "vary existing
// strategies" half of library mining; recombination is handled separately by the
// complementary-pairs suggester.
//
// Code strategies are left to the AI-improve flow; this pass mines builder
// strategies (strategyId + params), which have a well-defined neighbourhood.

import { runBacktest } from "../src/lib/backtest.js";
import { BUILT_IN_STRATEGIES } from "../src/lib/strategies.js";
import { windowProfile } from "../src/lib/windowProfile.js";
import { paramVariants } from "../src/lib/optimizer.js";
import { loadMarket } from "./marketdata.mjs";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
const MIN_SHARPE_GAIN = +(process.env.LAB_MINE_MIN_GAIN || 0.15); // a variant must beat the parent by this much Sharpe
const MAX_NEW = +(process.env.LAB_MINE_MAX_NEW || 6);            // new variants filed per run

async function candlesFor(entry) {
  const asset = entry.market === "crypto" ? "crypto" : "stock";
  const ds = await loadMarket({ id: entry.symbol, asset, symbol: entry.symbol, interval: entry.interval || "1d", range: entry.range || "5y", bars: 6000 });
  return ds?.candles || null;
}

function backtestParams(strategy, params, candles, entry) {
  const r = runBacktest({ candles, signalFn: strategy.build(params), initialCapital: 10000, feeBps: entry.feeBps ?? 10, positionPct: entry.positionPct ?? 100 });
  return r;
}

export async function mineLibrary() {
  if (!TOKEN) { console.error("LAB_TOKEN is not set."); return []; }
  let entries = [];
  try {
    const r = await fetch(`${SITE}/api/library`, { headers: { "x-lab-token": TOKEN } });
    const j = await r.json();
    entries = Array.isArray(j.entries) ? j.entries : [];
  } catch (e) { console.error(`[${new Date().toISOString()}] library fetch failed: ${e.message}`); return []; }

  // Seeds: builder strategies with a real track record, not buried/for-repair,
  // that we haven't already mined a variant of.
  const minedParents = new Set(entries.map((e) => e.minedFrom).filter(Boolean));
  const seeds = entries.filter((e) =>
    e.mode === "builder" && e.strategyId && e.params &&
    !["graveyard", "improve"].includes(e.status) &&
    (e.metrics?.sharpe ?? 0) > 0 && !minedParents.has(e.id));

  const filed = [];
  for (const entry of seeds) {
    if (filed.length >= MAX_NEW) break;
    const strategy = BUILT_IN_STRATEGIES.find((s) => s.id === entry.strategyId);
    if (!strategy?.params?.length) continue;
    try {
      const candles = await candlesFor(entry);
      if (!candles) continue;
      const base = backtestParams(strategy, entry.params, candles, entry);
      const baseSharpe = base.metrics.sharpe ?? -Infinity;
      let best = null;
      for (const variant of paramVariants(strategy.params, entry.params, 1)) {
        const r = backtestParams(strategy, variant, candles, entry);
        const s = r.metrics.sharpe ?? -Infinity;
        const betterEnough = s >= baseSharpe + MIN_SHARPE_GAIN &&
          r.metrics.maxDrawdownPct <= base.metrics.maxDrawdownPct * 1.05 &&
          r.metrics.tradeCount >= Math.max(20, base.metrics.tradeCount * 0.5);
        if (betterEnough && (!best || s > best.sharpe)) best = { variant, r, sharpe: s };
      }
      if (!best) continue;
      const m = best.r.metrics;
      const newEntry = {
        id: `mined_${entry.id}_${Date.now().toString(36)}`,
        createdAt: Date.now(),
        candidateId: null, minedFrom: entry.id,
        name: `variant · ${entry.name}`.slice(0, 60),
        market: entry.market, symbol: entry.symbol, interval: entry.interval, range: entry.range,
        mode: "builder", strategyId: entry.strategyId, params: best.variant,
        positionPct: entry.positionPct, feeBps: entry.feeBps,
        metrics: m, windowProfile: windowProfile(best.r.equity, { segments: 2 }),
        validation: { wf: null, dsr: null, noise: null },
        status: "factory", note: `mined from "${entry.name}" — Sharpe ${baseSharpe.toFixed(2)} → ${best.sharpe.toFixed(2)}`,
      };
      await fetch(`${SITE}/api/library`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN, upsert: newEntry }),
      });
      filed.push({ name: newEntry.name, gain: `${baseSharpe.toFixed(2)}→${best.sharpe.toFixed(2)}` });
    } catch (e) { console.error(`  ${(entry.name || "?").slice(0, 40)}: ${String(e.message).slice(0, 80)}`); }
  }
  console.log(`[${new Date().toISOString()}] mine-library: ${seeds.length} seeds · ${filed.length} variants filed${filed.length ? " — " + filed.map((f) => `${f.name} (${f.gain})`).join(", ") : ""}`);
  return filed;
}

if (process.argv[1] && /mine-library\.mjs$/.test(process.argv[1].replace(/\\/g, "/"))) {
  mineLibrary().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
