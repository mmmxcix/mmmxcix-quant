// mlMemory.js — the ML Studio's memory. Three honest mechanisms:
//
// 1. RUN LOG — every training run's config + out-of-sample result, so the
//    studio knows what it has already seen and how it scored.
// 2. PREDICTION LEDGER — every LIVE prediction (tomorrow's forecast, the
//    monthly top-10 ranking) is recorded the moment it's made and later
//    RESOLVED against what actually happened. This growing ledger is the
//    only evidence of real-world skill that accumulates over time.
// 3. Models retrain on ever-longer history each run — the one legitimate
//    way these models "get better". We do NOT pretend a Random Forest can
//    learn incrementally between runs; it can't.
//
// Storage: localStorage is the instant local cache; /api/mlmemory (KV) is the
// durable, CROSS-DEVICE home. The ledger is the only evidence of real
// out-of-sample skill, so it must survive a cache clear and follow the account
// to another machine. Writes go to both (server push is fire-and-forget and
// merges server-side, so two devices never overwrite each other). Never throws.

import { fetchCandles } from "@/lib/data";

const RUNS_KEY = "quant_ml_runs";
const PREDS_KEY = "quant_ml_preds";
const RUNS_CAP = 120;
const PREDS_CAP = 250;

const read = (key) => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
};
const writeLocal = (key, arr) => {
  try { localStorage.setItem(key, JSON.stringify(arr)); } catch { /* quota */ }
};

/** Persist locally AND push to the server (best-effort; local never blocks). */
const write = (key, arr) => {
  writeLocal(key, arr);
  const field = key === RUNS_KEY ? "runs" : "preds";
  try {
    fetch("/api/mlmemory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [field]: arr }),
      keepalive: true, // survives a tab close right after a run
    }).catch(() => { /* offline / not signed in — local copy stands */ });
  } catch { /* fetch unavailable */ }
};

/**
 * Pull the server copy and merge it into this browser. Call once when the track
 * record mounts: a fresh device then shows the full history instead of "empty",
 * and anything made here while offline is pushed back up.
 * @returns {Promise<boolean>} true when local data changed
 */
export async function syncFromServer() {
  try {
    const res = await fetch("/api/mlmemory");
    if (!res.ok) return false;
    const srv = await res.json();
    let changed = false;
    for (const [key, list, cap] of [[RUNS_KEY, srv.runs, RUNS_CAP], [PREDS_KEY, srv.preds, PREDS_CAP]]) {
      if (!Array.isArray(list)) continue;
      const local = read(key);
      const keyFn = key === RUNS_KEY
        ? (r) => `${r.ts}|${r.label}`
        : (p) => `${p.type}|${p.type === "ranking" ? p.month : `${p.symbol}|${p.model}|${p.lastBarTime}`}`;
      const by = new Map();
      for (const e of [...list, ...local]) {
        if (!e || typeof e !== "object") continue;
        const k = keyFn(e);
        const prev = by.get(k);
        if (!prev || (e.resolved && !prev.resolved)) by.set(k, e);
      }
      const merged = [...by.values()].sort((a, b) => (b.madeAt || b.ts || 0) - (a.madeAt || a.ts || 0)).slice(0, cap);
      if (merged.length !== local.length) changed = true;
      writeLocal(key, merged);
      // Push anything the server was missing (offline-made entries).
      if (merged.length !== list.length) write(key, merged);
    }
    return changed;
  } catch { return false; }
}

/* ── Run log ─────────────────────────────────────────────────────────── */

/** entry: { mode: "forecast"|"ranking", label, metric, metricLabel, detail } */
export function logRun(entry) {
  const runs = read(RUNS_KEY);
  runs.unshift({ ...entry, ts: Date.now() });
  write(RUNS_KEY, runs.slice(0, RUNS_CAP));
}

export const getRuns = () => read(RUNS_KEY);

/** Best previous out-of-sample metric for a config label (or null). */
export function bestRunFor(label) {
  const runs = read(RUNS_KEY).filter((r) => r.label === label && Number.isFinite(r.metric));
  if (!runs.length) return null;
  return runs.reduce((a, b) => (b.metric > a.metric ? b : a));
}

/* ── Prediction ledger ───────────────────────────────────────────────── */

/** Forecast: model said `predRet` for the bar AFTER lastBarTime. */
export function logForecastPrediction({ symbol, market, model, predRet, lastBarTime, lastClose }) {
  const preds = read(PREDS_KEY);
  // One open forecast per symbol+model per bar — re-running the same day
  // must not stack duplicate ledger entries.
  const dup = preds.some((p) => p.type === "forecast" && p.symbol === symbol && p.model === model && p.lastBarTime === lastBarTime);
  if (dup) return;
  preds.unshift({
    type: "forecast", symbol, market, model, predRet, lastBarTime, lastClose,
    madeAt: Date.now(), resolved: false, actualRet: null, hit: null,
  });
  write(PREDS_KEY, preds.slice(0, PREDS_CAP));
}

/** Ranking: the model's top picks, measured over the next ~30 days vs SPY. */
export function logRankingPrediction({ picks, month }) {
  const preds = read(PREDS_KEY);
  if (preds.some((p) => p.type === "ranking" && p.month === month)) return; // one per month
  preds.unshift({
    type: "ranking", month, picks, madeAt: Date.now(),
    resolved: false, picksRet: null, benchRet: null, spread: null,
  });
  write(PREDS_KEY, preds.slice(0, PREDS_CAP));
}

export const getPredictions = () => read(PREDS_KEY);

/* ── Resolution against reality ──────────────────────────────────────── */

const retSince = (candles, sinceSec) => {
  // Return from the last bar at/before `sinceSec` to the latest close.
  let base = null;
  for (const c of candles) { if (c.time <= sinceSec) base = c.close; else break; }
  const last = candles[candles.length - 1];
  return base > 0 && last ? last.close / base - 1 : null;
};

/**
 * Try to resolve all open predictions. Cheap by design: forecasts resolve
 * with one small fetch each; rankings only after their 30-day window, with
 * picks + SPY. Silent on failure — unresolved entries just stay pending.
 */
export async function resolvePredictions() {
  const preds = read(PREDS_KEY);
  let changed = false;
  for (const p of preds) {
    if (p.resolved) continue;
    try {
      if (p.type === "forecast") {
        // Needs at least one bar AFTER the bar the prediction was made on.
        const cs = await fetchCandles({ market: p.market || "stock", symbol: p.symbol, interval: "1d", range: "1mo" });
        const next = cs.find((c) => c.time > p.lastBarTime);
        if (!next) continue;
        p.actualRet = next.close / p.lastClose - 1;
        p.hit = Math.sign(p.actualRet) === Math.sign(p.predRet) && p.predRet !== 0;
        p.resolved = true;
        changed = true;
      } else if (p.type === "ranking") {
        if (Date.now() - p.madeAt < 30 * 86400_000) continue; // window still running
        const sinceSec = Math.floor(p.madeAt / 1000);
        const rets = [];
        for (const sym of p.picks.slice(0, 10)) {
          const cs = await fetchCandles({ market: "stock", symbol: sym, interval: "1d", range: "3mo" });
          const r = retSince(cs, sinceSec);
          if (r != null) rets.push(r);
        }
        if (rets.length < 5) continue;
        const spyCs = await fetchCandles({ market: "stock", symbol: "SPY", interval: "1d", range: "3mo" });
        const bench = retSince(spyCs, sinceSec);
        if (bench == null) continue;
        p.picksRet = rets.reduce((a, b) => a + b, 0) / rets.length;
        p.benchRet = bench;
        p.spread = p.picksRet - bench;
        p.resolved = true;
        changed = true;
      }
    } catch { /* stays pending — next visit retries */ }
  }
  if (changed) write(PREDS_KEY, preds);
  return changed;
}

/** Rolling live stats from the resolved ledger. */
export function ledgerStats() {
  const preds = read(PREDS_KEY);
  const f = preds.filter((p) => p.type === "forecast" && p.resolved);
  const r = preds.filter((p) => p.type === "ranking" && p.resolved);
  const hits = f.filter((p) => p.hit).length;
  return {
    forecastN: f.length,
    forecastHitRate: f.length ? hits / f.length : null,
    rankingN: r.length,
    rankingAvgSpread: r.length ? r.reduce((a, b) => a + b.spread, 0) / r.length : null,
    pending: preds.filter((p) => !p.resolved).length,
  };
}
