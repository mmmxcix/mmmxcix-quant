// argus-agent.mjs — the 24/7 day-trading agent, Phase 0 (technical channel, no
// LLM). See docs/DAYTRADER_AGENT.md. Runs continuously on the PC (autostart):
//   • every 15 min: full universe scan for new setups
//   • every  2 min: manage open theses (exits) + re-check forming setups
// Paper only. Persists to /api/argus. Env: LAB_TOKEN (req), LAB_SITE,
// LAB_ARGUS_EQUITY (paper start, default 10000).
import { loadMarket } from "./marketdata.mjs";
import { openThesis, evaluateExit } from "../src/lib/argus/core.js";
import { scan } from "../src/lib/argus/scanners.js";
import { buildBrief, diffBrief, renderBrief } from "../src/lib/argus/brief.js";
import { callArgusLLM } from "../src/lib/argus/llm.js";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
if (!TOKEN) { console.error("LAB_TOKEN is not set."); process.exit(1); }

const HEAT_CAP = +(process.env.LAB_ARGUS_HEAT || 0.06);
const BASE_RISK = +(process.env.LAB_ARGUS_RISK || 0.02);
const DAILY_STOP = +(process.env.LAB_ARGUS_DAILY_STOP || 0.04);
const EQUITY0 = +(process.env.LAB_ARGUS_EQUITY || 10000);
// Phase-1 event channel: LLM reads the alt-data briefing and proposes directional
// biases. Best-effort (free LLM pool is flaky) and opt-out via LAB_ARGUS_LLM=0.
const LLM_ON = process.env.LAB_ARGUS_LLM !== "0";
const EVENT_TTL = +(process.env.LAB_ARGUS_EVENT_TTL_MIN || 240) * 60_000; // biases expire (4h)
// News-reachable tickers Argus may trade if a catalyst clearly names them.
const EVENT_TICKERS = ["USO", "XLE", "ITA", "GLD", "UNG", "XOP", "SLV", "TLT", "UUP"];

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
let eventBias = new Map(); // symbol -> { side, thesis, confidence, evidence, horizon, at, model }
let prevBrief = null;

const openRisk = () => open.reduce((a, t) => a + t.riskAmt, 0);
const isCore = (sym) => UNIVERSE.some((u) => u.symbol === sym);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Descriptor for an arbitrary ticker the event channel names (crypto vs stock). */
function instFor(symbol) {
  const s = symbol.toUpperCase();
  return /USDT$/.test(s) ? { id: s, asset: "crypto", symbol: s } : { id: s, asset: "stock", symbol: s };
}

/** Base universe + any event-named tickers currently carrying a fresh bias. */
function activeUniverse() {
  const extra = [...eventBias.keys()].filter((s) => !isCore(s)).map(instFor);
  return [...UNIVERSE, ...extra];
}

/** Event channel: read the alt-data briefing, ask the LLM for directional biases.
 *  Best-effort — a flaky free LLM pool just means no new biases this cycle. */
async function runEventChannel() {
  if (!LLM_ON) return;
  try {
    const get = async (p) => { try { const r = await fetch(SITE + p); return r.ok ? await r.json() : null; } catch { return null; } };
    const [world, conflicts, disasters, news] = await Promise.all([get("/api/world"), get("/api/conflicts"), get("/api/disasters"), get("/api/news")]);
    const brief = buildBrief({ world, conflicts: conflicts?.conflicts, disasters: disasters?.disasters, news });
    brief.deltas = diffBrief(prevBrief, brief);
    prevBrief = brief;
    const ctx = { universe: [...UNIVERSE.map((u) => u.symbol), ...EVENT_TICKERS], open: open.map((o) => o.symbol) };
    const out = await callArgusLLM(renderBrief(brief), ctx);
    const now = Date.now();
    for (const [k, v] of eventBias) if (now - v.at > EVENT_TTL) eventBias.delete(k); // prune stale
    if (!out.ok) { console.log(`[${new Date().toISOString()}] event: llm unavailable (${out.error})`); return; }
    for (const t of out.theses) {
      if (!/^[A-Z]{1,6}(USDT)?$/.test(t.symbol)) continue; // sane ticker only
      if (!isCore(t.symbol) && !EVENT_TICKERS.includes(t.symbol)) continue; // don't invent instruments
      eventBias.set(t.symbol, { side: t.side, thesis: t.thesis, confidence: t.confidence, evidence: t.evidence, horizon: t.horizon, at: now, model: out.model });
    }
    if (out.theses.length) console.log(`[${new Date().toISOString()}] event: ${out.theses.length} bias via ${out.model} — ${out.theses.map((t) => `${t.symbol} ${t.side}`).join(", ")}`);
  } catch (e) { console.log(`[${new Date().toISOString()}] event failed: ${e.message}`); }
}

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
  const bias = eventBias.get(inst.symbol);
  // Event-only tickers (added purely because news named them) trade only with a
  // matching-direction catalyst — price alone isn't enough to justify them.
  if (!isCore(inst.symbol) && (!bias || bias.side !== setup.side)) return;
  const th = openThesis(
    { ...setup, symbol: inst.symbol, market: inst.asset },
    { equity, openRisk: openRisk(), asset: inst.asset, heatCap: HEAT_CAP, baseRiskPct: BASE_RISK },
  );
  if (th) {
    if (bias && bias.side === th.side) { // enrich a confirmed setup with its catalyst
      th.catalyst = bias.thesis;
      th.confidence = bias.confidence;
      th.horizon = bias.horizon;
      if (bias.evidence?.length) th.evidence = [...new Set([...(th.evidence || []), ...bias.evidence])].slice(0, 6);
      th.reason = `⚡ ${th.reason}`;
    }
    open.push(th);
    forming = forming.filter((f) => f.symbol !== inst.symbol);
    console.log(`[${new Date().toISOString()}] OPEN ${th.symbol} ${th.side} ${th.kind}${th.catalyst ? " [event]" : ""} @${th.entry.toFixed(4)} stop ${th.stop.toFixed(4)} tgt ${th.target.toFixed(4)} risk ${th.riskAmt.toFixed(0)} — ${th.reason}`);
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

    // Full scans consult the event channel first, so news-driven biases are live
    // before the technical scan runs (and can expand the universe).
    if (fullScan) await runEventChannel();

    // On the fast loop, only touch instruments with an open thesis or a forming setup.
    const uni = activeUniverse();
    const active = new Set([...open.map((o) => o.symbol), ...forming.map((f) => f.symbol)]);
    const insts = fullScan ? uni : uni.filter((i) => active.has(i.symbol));

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

    await persist(ledgerAdd, { halted, dailyPnl });
    if (fullScan) console.log(`[${new Date().toISOString()}] scan: ${open.length} open · ${forming.length} forming · ${eventBias.size} event-bias · eq ${equity.toFixed(0)} · heat ${(openRisk() / equity * 100).toFixed(1)}%${halted ? " · DAILY-HALT" : ""}`);
  } catch (e) {
    console.error(`cycle failed: ${e.message}`);
  } finally {
    cycleRunning = false;
  }
}

async function persist(ledgerAdd, extra) {
  const events = [...eventBias.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 12)
    .map(([symbol, v]) => ({ symbol, side: v.side, thesis: v.thesis, confidence: v.confidence, horizon: v.horizon, at: v.at, model: v.model }));
  const body = {
    token: TOKEN,
    state: { equity, open: open.length, forming: forming.length, heatPct: openRisk() / equity, dayPnl: extra.dailyPnl, halted: extra.halted, universe: activeUniverse().length, events },
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
    for (const e of j.state?.events || []) { // restore fresh event biases across restarts
      if (Date.now() - (e.at || 0) < EVENT_TTL) eventBias.set(e.symbol, { side: e.side, thesis: e.thesis, confidence: e.confidence, evidence: [], horizon: e.horizon, at: e.at, model: e.model });
    }
    equityDayStart = equity;
    console.log(`hydrated: eq ${equity.toFixed(0)}, ${open.length} open theses, ${eventBias.size} event-bias`);
  } catch { /* fresh start */ }
}

await hydrate();
setInterval(() => cycle(true), 15 * 60_000);
setInterval(() => cycle(false), 2 * 60_000);
cycle(true);
console.log(`Argus running — universe ${UNIVERSE.length} core (+${EVENT_TICKERS.length} event) · event-channel ${LLM_ON ? "on" : "off"} · heat ${HEAT_CAP * 100}% cap / ${BASE_RISK * 100}% base · daily stop ${DAILY_STOP * 100}% · paper eq ${EQUITY0}`);
