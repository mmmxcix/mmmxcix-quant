// argus-agent.mjs — the 24/7 day-trading agent, Phase 0 (technical channel, no
// LLM). See docs/DAYTRADER_AGENT.md. Runs continuously on the PC (autostart):
//   • every 15 min: full universe scan for new setups
//   • every  2 min: manage open theses (exits) + re-check forming setups
// Paper only. Persists to /api/argus. Env: LAB_TOKEN (req), LAB_SITE,
// LAB_ARGUS_EQUITY (paper start, default 10000).
import { loadMarket } from "./marketdata.mjs";
import { openThesis, evaluateExit } from "../src/lib/argus/core.js";
import { scan } from "../src/lib/argus/scanners.js";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
if (!TOKEN) { console.error("LAB_TOKEN is not set."); process.exit(1); }

const HEAT_CAP = +(process.env.LAB_ARGUS_HEAT || 0.06);
const BASE_RISK = +(process.env.LAB_ARGUS_RISK || 0.02);
const DAILY_STOP = +(process.env.LAB_ARGUS_DAILY_STOP || 0.04);
const EQUITY0 = +(process.env.LAB_ARGUS_EQUITY || 10000);

// Phase-0 universe: instruments with solid free intraday data (crypto = Binance,
// stocks/ETFs = Yahoo). Forex intraday is added once a data source is wired.
const UNIVERSE = [
  { id: "BTCUSDT", asset: "crypto", symbol: "BTCUSDT" },
  { id: "ETHUSDT", asset: "crypto", symbol: "ETHUSDT" },
  { id: "SOLUSDT", asset: "crypto", symbol: "SOLUSDT" },
  { id: "SPY", asset: "stock", symbol: "SPY" },
  { id: "QQQ", asset: "stock", symbol: "QQQ" },
  { id: "NVDA", asset: "stock", symbol: "NVDA" },
  { id: "AAPL", asset: "stock", symbol: "AAPL" },
];

let equity = EQUITY0;
let open = [];          // open theses
let forming = [];       // parked "approaching" setups {symbol, asset, side, kind, trigger, reason}
let closedToday = [];
let dayStamp = new Date().getUTCDate();
let equityDayStart = EQUITY0;
let cycleRunning = false;

const openRisk = () => open.reduce((a, t) => a + t.riskAmt, 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadTF(inst) {
  if (inst.asset === "crypto") {
    // Binance is happy with parallel bursts.
    const [c5, c15, c1h] = await Promise.all([
      loadMarket({ ...inst, interval: "5m", bars: 1000 }),
      loadMarket({ ...inst, interval: "15m", bars: 1000 }),
      loadMarket({ ...inst, interval: "1h", bars: 1000 }),
    ]);
    return { c5: c5?.candles, c15: c15?.candles, c1h: c1h?.candles };
  }
  // Yahoo throttles parallel bursts from one IP → fetch stock TFs sequentially.
  const c5 = await loadMarket({ ...inst, interval: "5m", range: "1mo" }); await sleep(250);
  const c15 = await loadMarket({ ...inst, interval: "15m", range: "3mo" }); await sleep(250);
  const c1h = await loadMarket({ ...inst, interval: "1h", range: "6mo" });
  return { c5: c5?.candles, c15: c15?.candles, c1h: c1h?.candles };
}

function manageExits(inst, last5, ledgerAdd) {
  for (const th of open.filter((o) => o.symbol === inst.symbol)) {
    const res = evaluateExit(th, last5);
    if (res) {
      open = open.filter((o) => o.id !== th.id);
      equity += res.pnl;
      closedToday.push(res);
      ledgerAdd.push(res);
      console.log(`[${new Date().toISOString()}] CLOSE ${res.symbol} ${res.side} ${res.outcome} R=${res.R.toFixed(2)} pnl=${res.pnl.toFixed(2)} eq=${equity.toFixed(0)}`);
    }
  }
}

function tryOpen(inst, setup, halted) {
  if (halted) return;
  if (open.some((o) => o.symbol === inst.symbol)) return; // one position per instrument
  const th = openThesis(
    { ...setup, symbol: inst.symbol, market: inst.asset },
    { equity, openRisk: openRisk(), asset: inst.asset, heatCap: HEAT_CAP, baseRiskPct: BASE_RISK },
  );
  if (th) {
    open.push(th);
    forming = forming.filter((f) => f.symbol !== inst.symbol);
    console.log(`[${new Date().toISOString()}] OPEN ${th.symbol} ${th.side} ${th.kind} @${th.entry.toFixed(4)} stop ${th.stop.toFixed(4)} tgt ${th.target.toFixed(4)} risk ${th.riskAmt.toFixed(0)} — ${th.reason}`);
  } else {
    // no heat room → park as forming so it's re-checked on the fast loop
    if (!forming.some((f) => f.symbol === inst.symbol)) forming.push({ symbol: inst.symbol, asset: inst.asset, side: setup.side, kind: setup.kind, reason: "waiting for heat: " + setup.reason });
  }
}

function resetDayIfNeeded() {
  const d = new Date().getUTCDate();
  if (d !== dayStamp) { dayStamp = d; closedToday = []; equityDayStart = equity; }
}

async function cycle(fullScan) {
  if (cycleRunning) return;
  cycleRunning = true;
  const ledgerAdd = [];
  try {
    resetDayIfNeeded();
    const dailyPnl = closedToday.reduce((a, c) => a + c.pnl, 0);
    const halted = dailyPnl <= -DAILY_STOP * equityDayStart;

    // On the fast loop, only touch instruments with an open thesis or a forming setup.
    const active = new Set([...open.map((o) => o.symbol), ...forming.map((f) => f.symbol)]);
    const insts = fullScan ? UNIVERSE : UNIVERSE.filter((i) => active.has(i.symbol));

    for (const inst of insts) {
      let tf;
      try { tf = await loadTF(inst); } catch { continue; }
      if (!tf.c5 || tf.c5.length < 40) continue;
      manageExits(inst, tf.c5[tf.c5.length - 1], ledgerAdd);
      // Scan for new / re-check forming: both use the same scan; the fast loop
      // catches a forming setup the moment it triggers ("watch until entry").
      if (tf.c15 && tf.c1h) {
        const { triggered } = scan(tf);
        for (const s of triggered) tryOpen(inst, s, halted);
      }
      if (inst.asset !== "crypto") await sleep(400); // be gentle on Yahoo
    }

    const bias = {}; // brief; per-instrument bias could be added later
    await persist(ledgerAdd, { halted, dailyPnl });
    if (fullScan) console.log(`[${new Date().toISOString()}] scan: ${open.length} open · ${forming.length} forming · eq ${equity.toFixed(0)} · heat ${(openRisk() / equity * 100).toFixed(1)}%${halted ? " · DAILY-HALT" : ""}`);
  } catch (e) {
    console.error(`cycle failed: ${e.message}`);
  } finally {
    cycleRunning = false;
  }
}

async function persist(ledgerAdd, extra) {
  const body = {
    token: TOKEN,
    state: { equity, open: open.length, forming: forming.length, heatPct: openRisk() / equity, dayPnl: extra.dailyPnl, halted: extra.halted, universe: UNIVERSE.length },
    theses: open,
    ledgerAdd,
  };
  try {
    const r = await fetch(`${SITE}/api/argus`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) console.error(`persist HTTP ${r.status}`);
  } catch (e) { console.error(`persist failed: ${e.message}`); }
}

async function hydrate() {
  try {
    const r = await fetch(`${SITE}/api/argus?what=all`);
    if (!r.ok) return;
    const j = await r.json();
    if (j.state?.equity) equity = j.state.equity;
    if (Array.isArray(j.theses)) open = j.theses;
    equityDayStart = equity;
    console.log(`hydrated: eq ${equity.toFixed(0)}, ${open.length} open theses`);
  } catch { /* fresh start */ }
}

await hydrate();
setInterval(() => cycle(true), 15 * 60_000);
setInterval(() => cycle(false), 2 * 60_000);
cycle(true);
console.log(`Argus running — universe ${UNIVERSE.length} · heat ${HEAT_CAP * 100}% cap / ${BASE_RISK * 100}% base · daily stop ${DAILY_STOP * 100}% · paper eq ${EQUITY0}`);
