// lab-agent.mjs v0.2 — the local paper-trading agent (Threepio phase 3).
// Runs on the user's PC (n8n schedules it every 15 min):
//
//   1. fetches the published paper strategies from the site (lab:strategies)
//   2. executes each on fresh market data using the SITE'S OWN engine code
//      (imported straight from ../src/lib — one engine, zero drift)
//   3. keeps virtual positions/equity in a local state file
//   4. pushes the portfolio state back to the site (lab:state → Coach page)
//
// Paper fill model (v1, honest): the current desired position is derived by
// running the real backtest engine over the recent window; when it differs
// from the held virtual position, the change fills at the latest close with
// the strategy's own fee. Positions persist across runs in ~/.mmmxcix-lab.json.
// All money is virtual. Not investment advice.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runBacktest, compileStrategy } from "../src/lib/backtest.js";
import { BUILT_IN_STRATEGIES } from "../src/lib/strategies.js";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
const STATE_FILE = join(homedir(), ".mmmxcix-lab.json");
const START_EQUITY = 10000;
const WARMUP_BARS = 500; // enough for EMA200 + stateful strategies
const YAHOO_INTERVAL = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "1d": "1d", "1w": "1wk", "1M": "1mo" };
const YAHOO_RANGE = { "1m": "5d", "5m": "1mo", "15m": "1mo", "30m": "3mo", "1h": "3mo", "1d": "2y", "1w": "10y", "1M": "max" };

if (!TOKEN) {
  console.error("LAB_TOKEN is not set. PowerShell: $env:LAB_TOKEN = \"<dev token>\"");
  process.exit(1);
}

// ── data ────────────────────────────────────────────────────────────────────
async function fetchCrypto(symbol, interval, bars) {
  let out = [], end = Date.now();
  while (out.length < bars) {
    const rows = await (await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${end}&limit=1000`)).json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out = [...rows.map((r) => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })), ...out];
    end = rows[0][0] - 1;
    if (rows.length < 1000) break;
  }
  return out.slice(-bars);
}
async function fetchStock(symbol, interval) {
  const yi = YAHOO_INTERVAL[interval] || "1d";
  const yr = YAHOO_RANGE[interval] || "2y";
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${yr}&interval=${yi}`,
    { headers: { "user-agent": "Mozilla/5.0" } });
  const r = (await res.json())?.chart?.result?.[0];
  if (!r) throw new Error(`no data for ${symbol}`);
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return out.slice(-WARMUP_BARS);
}

// ── strategy → current desired position ────────────────────────────────────
function buildSignalFn(s) {
  if (s.mode === "builder") {
    const def = BUILT_IN_STRATEGIES.find((b) => b.id === s.strategyId);
    if (!def) throw new Error(`unknown builder strategy ${s.strategyId}`);
    return def.build(s.params || {});
  }
  return compileStrategy(s.code || "");
}

// Run the real engine over the window; if a position was still open on the
// last bar, the engine force-closes it with reason "eod" — that IS the
// strategy's current desired position.
function desiredPosition(s, candles) {
  const res = runBacktest({
    candles, signalFn: buildSignalFn(s),
    initialCapital: 10000, feeBps: s.feeBps ?? 10, positionPct: s.positionPct ?? 100,
  });
  const lastBar = candles[candles.length - 1];
  const t = res.trades[res.trades.length - 1];
  if (t && t.reason === "eod" && t.exitTime === lastBar.time) return t.side;
  return "flat";
}

// ── virtual portfolio accounting (same math as the engine) ─────────────────
function loadLocal() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { strategies: {}, combinedHistory: [] }; }
}
function saveLocal(st) {
  try { writeFileSync(STATE_FILE, JSON.stringify(st)); } catch (e) { console.error("state save failed:", e.message); }
}

function applyTarget(ps, target, price, feeBps, positionPct) {
  const fee = (feeBps ?? 10) / 10000;
  const posFrac = Math.min(100, Math.max(1, positionPct ?? 100)) / 100;
  const mtm = () => (ps.position === "flat"
    ? ps.equity
    : ps.equityAfterEntry + (ps.position === "long" ? 1 : -1) * ps.units * (price - ps.entryPrice));

  let trade = null;
  if (ps.position !== "flat" && target !== ps.position) {
    const gross = mtm();
    const exitFee = ps.units * price * fee;
    const finalEq = gross - exitFee;
    trade = {
      side: ps.position, entryPrice: ps.entryPrice, exitPrice: price,
      pnl: +(finalEq - ps.entryEquity).toFixed(2),
      pnlPct: ps.entryEquity > 0 ? +(((finalEq - ps.entryEquity) / ps.entryEquity) * 100).toFixed(2) : 0,
      closedAt: Date.now(),
    };
    ps.equity = finalEq;
    ps.position = "flat";
    ps.units = 0;
  }
  if (target !== "flat" && ps.position === "flat") {
    const committed = ps.equity * posFrac;
    ps.entryEquity = ps.equity;
    ps.equityAfterEntry = ps.equity - committed * fee;
    ps.units = price > 0 ? (committed * (1 - fee)) / price : 0;
    ps.entryPrice = price;
    ps.position = target;
    ps.openedAt = Date.now();
  }
  ps.markEquity = +mtm().toFixed(2);
  return trade;
}

// ── main ────────────────────────────────────────────────────────────────────
const stratRes = await fetch(`${SITE}/api/lab?what=strategies`, { headers: { "x-lab-token": TOKEN } });
const stratOut = await stratRes.json().catch(() => ({}));
if (!stratRes.ok) { console.error("strategy fetch failed:", stratRes.status, stratOut); process.exit(1); }
const published = stratOut.strategies?.items || [];

const local = loadLocal();
const summaries = [];
let note = published.length === 0 ? "no strategies published — bury or promote some in the Registry" : "";

for (const s of published) {
  try {
    const candles = s.market === "crypto"
      ? await fetchCrypto(s.symbol, s.interval, WARMUP_BARS)
      : await fetchStock(s.symbol, s.interval);
    if (candles.length < 60) throw new Error("too little data");
    const price = candles[candles.length - 1].close;
    const target = desiredPosition(s, candles);

    const ps = local.strategies[s.id] || { equity: START_EQUITY, position: "flat", units: 0, trades: [] };
    const trade = applyTarget(ps, target, price, s.feeBps, s.positionPct);
    if (trade) { ps.trades = [...(ps.trades || []), trade].slice(-10); console.log(`${s.name}: ${trade.side} closed ${trade.pnlPct}%`); }
    local.strategies[s.id] = ps;

    summaries.push({
      id: s.id, name: s.name, symbol: s.symbol, interval: s.interval,
      position: ps.position, equity: ps.markEquity,
      returnPct: +(((ps.markEquity / START_EQUITY) - 1) * 100).toFixed(2),
      tradeCount: (ps.trades || []).length,
      lastTrade: (ps.trades || [])[ps.trades.length - 1] || null,
      price,
    });
  } catch (e) {
    summaries.push({ id: s.id, name: s.name, symbol: s.symbol, interval: s.interval, error: e.message });
    console.error(`${s.name}: ${e.message}`);
  }
}

// prune local state for unpublished strategies (keep — they may come back)
const combined = summaries.filter((x) => !x.error).reduce((a, x) => a + x.equity, 0);
if (summaries.some((x) => !x.error)) {
  local.combinedHistory = [...(local.combinedHistory || []), { t: Date.now(), v: +combined.toFixed(2) }].slice(-200);
}
saveLocal(local);

// The research agent writes state.research into the SAME state object; read
// the current state first so we don't clobber its counters when we push ours.
let priorResearch = null;
try {
  const cur = await (await fetch(`${SITE}/api/lab`, { headers: { "x-lab-token": TOKEN } })).json();
  priorResearch = cur?.state?.research || null;
} catch { /* first run / offline */ }

const state = {
  agent: "lab-agent v0.2",
  mode: published.length ? "paper" : "idle",
  lastRunAt: Date.now(),
  research: priorResearch, // preserve the research loop's stats
  strategies: summaries,
  combined: summaries.some((x) => !x.error)
    ? {
        equity: +combined.toFixed(2),
        startEquity: summaries.filter((x) => !x.error).length * START_EQUITY,
        returnPct: +(((combined / (summaries.filter((x) => !x.error).length * START_EQUITY)) - 1) * 100).toFixed(2),
        history: local.combinedHistory.slice(-100),
      }
    : null,
  note,
};

const push = await fetch(`${SITE}/api/lab`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: TOKEN, state }),
});
const out = await push.json().catch(() => ({}));
if (!push.ok || !out.ok) { console.error("push failed:", push.status, out); process.exit(1); }
console.log(`paper run complete: ${summaries.length} strategies, combined ${combined ? combined.toFixed(0) : "-"} → pushed ${out.bytes} bytes`);
