// argus-agent.mjs — the 24/7 day-trading agent, Phase 0 (technical channel, no
// LLM). See docs/DAYTRADER_AGENT.md. Runs continuously on the PC (autostart):
//   • every 15 min: full universe scan for new setups
//   • every  2 min: manage open theses (exits) + re-check forming setups
// Paper only. Persists to /api/argus. Env: LAB_TOKEN (req), LAB_SITE,
// LAB_ARGUS_EQUITY (paper start, default 10000).
import { loadMarket } from "./marketdata.mjs";
import { openThesis, evaluateExit, closeThesisAt } from "../src/lib/argus/core.js";
import { scan } from "../src/lib/argus/scanners.js";
import { buildBrief, diffBrief, renderBrief } from "../src/lib/argus/brief.js";
import { deriveLessons, adjustment, sessionOf } from "../src/lib/argus/learn.js";
import { marketOpen } from "../src/lib/argus/hours.js";
import { buildReflectionMessages, parseReflection, crystallise, skillsFor } from "../src/lib/argus/reflect.js";
import { callArgusLLM, chatOnce } from "../src/lib/argus/llm.js";

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
// Hermes-style learning: buckets need at least this many closed trades before any
// lesson is allowed to touch sizing (small samples lie). Tunable, conservative.
const LEARN_MIN = +(process.env.LAB_ARGUS_LEARN_MIN || 20);
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
let ledger = [];        // closed theses (mirror of KV argus:ledger, for learning)
let lessons = [];       // current Hermes lessons derived from the ledger (recomputed each full scan)
let closedAll = [];     // closed-thesis ledger the lessons are learned from (hydrated + appended)
let closedToday = [];
let dayStamp = new Date().getUTCDate();
let equityDayStart = EQUITY0;
let cycleRunning = false;
let eventBias = new Map(); // symbol -> { side, thesis, confidence, evidence, horizon, at, model }
let prevBrief = null;
let journal = [];       // Hermes post-mortems, newest first
let skills = [];        // lessons crystallised from repeats — consulted before a trade
let reflectQueue = [];  // closed trades awaiting their post-mortem
let forceClose = new Set(); // thesis ids the dev asked to close now (drained each cycle)
let pendingCommands = []; // raw dev commands drained this cycle, acked once handled
let lastPersistSig = ""; // skip redundant KV writes on the fast loop (write budget)

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
    // Dev "close now" takes priority over the normal stop/target check.
    const res = forceClose.has(th.id) ? closeThesisAt(th, last5.close) : evaluateExit(th, last5);
    if (res) {
      open = open.filter((o) => o.id !== th.id);
      equity += res.pnl;
      closedToday.push(res);
      ledgerAdd.push(res);
      closedAll.push(res); // feed the learning ledger
      reflectQueue.push(res); // Hermes: every closed trade earns a post-mortem
      if (closedAll.length > 600) closedAll = closedAll.slice(-600);
      console.log(`[${new Date().toISOString()}] CLOSE ${res.symbol} ${res.side} ${res.outcome} R=${res.R.toFixed(2)} pnl=${res.pnl.toFixed(2)} eq=${equity.toFixed(0)}`);
    }
  }
}


/** Hermes REFLECT step: one post-mortem per closed trade, written into the
 *  journal. Best-effort — a flaky LLM just means the trade waits for the next
 *  cycle. Bounded per run so a backlog can't stall the agent. */
async function runReflections(max = 3) {
  if (!LLM_ON || !reflectQueue.length) return;
  const recentLessons = journal.slice(0, 8).map((r) => r.lesson).filter(Boolean);
  for (let i = 0; i < max && reflectQueue.length; i++) {
    const trade = reflectQueue.shift();
    try {
      const out = await chatOnce(buildReflectionMessages(trade, { recentLessons }), { maxTokens: 420 });
      if (!out.ok) { reflectQueue.unshift(trade); break; } // LLM down — retry next cycle
      const entry = parseReflection(out.text, trade);
      if (!entry) continue;
      journal.unshift(entry);
      if (journal.length > 300) journal = journal.slice(0, 300);
      console.log(`[${new Date().toISOString()}] REFLECT ${trade.symbol} ${trade.outcome} ${entry.verdict}: ${entry.lesson || entry.cause}`);
    } catch { reflectQueue.unshift(trade); break; }
  }
  // CRYSTALLISE: a lesson written down repeatedly for the same situation becomes
  // a rule the agent obeys before its next trade of that kind.
  skills = crystallise(journal);
}

function tryOpen(inst, setup, halted) {
  if (halted) return;
  if (!marketOpen(inst)) return;                          // never open a closed market
  if (open.some((o) => o.symbol === inst.symbol)) return; // one position per instrument
  const bias = eventBias.get(inst.symbol);
  // Event-only tickers (added purely because news named them) trade only with a
  // matching-direction catalyst — price alone isn't enough to justify them.
  if (!isCore(inst.symbol) && (!bias || bias.side !== setup.side)) return;

  // Hermes learning: nudge (or veto) sizing from what the ledger has taught us
  // about this kind of setup. Gentle by construction — mult is hard-clamped and
  // only buckets with ≥ LEARN_MIN closed trades count.
  const evented = bias && bias.side === setup.side;
  const adj = adjustment(lessons, {
    kind: setup.kind, symbol: inst.symbol, side: setup.side,
    session: sessionOf(Date.now()), source: evented ? "event" : "technical", bias: setup.bias,
  }, { minSample: LEARN_MIN });
  if (adj.skip) {
    console.log(`[${new Date().toISOString()}] SKIP ${inst.symbol} ${setup.side} ${setup.kind} — lesson: ${adj.reasons[0] || "losing bucket"}`);
    return;
  }
  // REUSE — the last Hermes step. A rule the agent wrote down repeatedly for
  // exactly this situation ("avoid") vetoes the trade; a "prefer" one is noted
  // on the thesis so the reasoning is visible rather than hidden in a number.
  const applicable = skillsFor(skills, { kind: setup.kind, symbol: inst.symbol, side: setup.side });
  const veto = applicable.find((s) => s.verdict === "avoid" && s.times >= 3 && s.avgR < 0);
  if (veto) {
    console.log(`[${new Date().toISOString()}] SKIP ${inst.symbol} ${setup.side} ${setup.kind} — skill (${veto.times}×, ${veto.avgR}R): ${veto.lesson}`);
    return;
  }
  const riskPct = BASE_RISK * adj.mult;

  const th = openThesis(
    { ...setup, symbol: inst.symbol, market: inst.asset },
    { equity, openRisk: openRisk(), asset: inst.asset, heatCap: HEAT_CAP, baseRiskPct: riskPct },
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
    if (adj.mult !== 1) console.log(`[${new Date().toISOString()}] LESSON ${inst.symbol} size ×${adj.mult.toFixed(2)} — ${adj.reasons[0] || ""}`);
    console.log(`[${new Date().toISOString()}] OPEN ${th.symbol} ${th.side} ${th.kind}${th.catalyst ? " [event]" : ""} @${th.entry.toFixed(4)} stop ${th.stop.toFixed(4)} tgt ${th.target.toFixed(4)} risk ${th.riskAmt.toFixed(0)} — ${th.reason}`);
  } else {
    // no heat room → park as forming so it's re-checked on the fast loop
    if (!forming.some((f) => f.symbol === inst.symbol)) forming.push({ symbol: inst.symbol, asset: inst.asset, side: setup.side, kind: setup.kind, reason: "waiting for heat: " + setup.reason });
  }
}

/** Drain the dev command queue (admin-issued "close now" / "cancel"). Closes are
 *  deferred to manageExits (they need a live price); cancels act immediately. */
async function drainCommands() {
  try {
    const r = await fetch(`${SITE}/api/argus?what=commands`);
    const j = await r.json();
    pendingCommands = Array.isArray(j.commands) ? j.commands : [];
  } catch { pendingCommands = []; return; }
  for (const c of pendingCommands) {
    if (c.type === "close") {
      forceClose.add(c.id);
    } else if (c.type === "cancel") {
      const before = forming.length;
      forming = forming.filter((f) => f.symbol !== c.id);
      if (eventBias.has(c.id)) eventBias.delete(c.id);
      if (forming.length !== before || eventBias.size) console.log(`[${new Date().toISOString()}] CANCEL ${c.id} (dev)`);
    }
  }
}

/** Ack the commands we've now carried out so the queue clears. A close is only
 *  acked once its thesis is actually gone from `open`; a cancel is immediate. */
async function ackCommands() {
  if (!pendingCommands.length) return;
  const ack = [];
  for (const c of pendingCommands) {
    if (c.type === "cancel") ack.push(c.id);
    else if (c.type === "close" && !open.some((o) => o.id === c.id)) { ack.push(c.id); forceClose.delete(c.id); }
  }
  pendingCommands = [];
  if (!ack.length) return;
  try {
    await fetch(`${SITE}/api/argus`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, commandAck: ack }),
    });
  } catch { /* retried next cycle */ }
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
    await drainCommands(); // act on dev "close now" / "cancel" this cycle (fast + full)
    const dailyPnl = closedToday.reduce((a, c) => a + c.pnl, 0);
    const halted = dailyPnl <= -DAILY_STOP * equityDayStart;

    // Full scans consult the event channel first, so news-driven biases are live
    // before the technical scan runs (and can expand the universe). Then relearn
    // from the closed-thesis ledger so this scan's sizing reflects the latest edge.
    if (fullScan) {
      await runEventChannel();
      await runReflections();
      lessons = deriveLessons(closedAll, { minSample: LEARN_MIN });
    }

    // On the fast loop, only touch instruments with an open thesis or a forming
    // setup. Skip instruments whose market is CLOSED (weekends/after-hours for
    // stocks) — a real day-trader trades only what's open; still keep anything we
    // already hold so its exits are managed.
    const uni = activeUniverse();
    const active = new Set([...open.map((o) => o.symbol), ...forming.map((f) => f.symbol)]);
    const insts = (fullScan ? uni : uni.filter((i) => active.has(i.symbol))).filter((i) => marketOpen(i) || active.has(i.symbol));

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

    // Only write to KV when something changed or on a full scan (which doubles as
    // the ~15-min heartbeat). The 2-min watch loop otherwise stays silent — this
    // keeps us inside the free KV daily write budget.
    const sig = JSON.stringify([open.map((o) => o.id).sort(), forming.map((f) => f.symbol).sort(), [...eventBias.keys()].sort(), halted]);
    if (fullScan || ledgerAdd.length || sig !== lastPersistSig) {
      await persist(ledgerAdd, { halted, dailyPnl });
      lastPersistSig = sig;
    }
    await ackCommands(); // clear handled dev commands from the queue
    if (fullScan) console.log(`[${new Date().toISOString()}] scan: ${insts.length}/${uni.length} open-mkt · ${open.length} open · ${forming.length} forming · ${eventBias.size} event-bias · ${lessons.length} lessons · eq ${equity.toFixed(0)} · heat ${(openRisk() / equity * 100).toFixed(1)}%${halted ? " · DAILY-HALT" : ""}`);
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
    state: { equity, open: open.length, forming: forming.length, heatPct: openRisk() / equity, dayPnl: extra.dailyPnl, halted: extra.halted, universe: activeUniverse().length, events, skills: skills.slice(0, 8), lessons: lessons.slice(0, 8).map((l) => ({ text: l.text, verdict: l.verdict, n: l.n })) },
    theses: open,
    ledgerAdd,
    journal: journal.slice(0, 60),   // Hermes post-mortems (newest first)
    skills,                          // rules crystallised from repeated lessons
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
    if (Array.isArray(j.ledger)) { // learn from the full closed ledger on startup
      closedAll = j.ledger.slice(-600);
      lessons = deriveLessons(closedAll, { minSample: LEARN_MIN });
    }
    if (Array.isArray(j.journal)) journal = j.journal.slice(0, 300);
    if (Array.isArray(j.skills)) skills = j.skills;
    for (const e of j.state?.events || []) { // restore fresh event biases across restarts
      if (Date.now() - (e.at || 0) < EVENT_TTL) eventBias.set(e.symbol, { side: e.side, thesis: e.thesis, confidence: e.confidence, evidence: [], horizon: e.horizon, at: e.at, model: e.model });
    }
    equityDayStart = equity;
    console.log(`hydrated: eq ${equity.toFixed(0)}, ${open.length} open theses, ${eventBias.size} event-bias, ${closedAll.length} closed → ${lessons.length} lessons, ${journal.length} reflections → ${skills.length} skills`);
  } catch { /* fresh start */ }
}

await hydrate();
setInterval(() => cycle(true), 15 * 60_000);
setInterval(() => cycle(false), 2 * 60_000);
cycle(true);
console.log(`Argus running — universe ${UNIVERSE.length} core (+${EVENT_TICKERS.length} event) · event-channel ${LLM_ON ? "on" : "off"} · heat ${HEAT_CAP * 100}% cap / ${BASE_RISK * 100}% base · daily stop ${DAILY_STOP * 100}% · paper eq ${EQUITY0}`);
