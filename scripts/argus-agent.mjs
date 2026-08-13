// argus-agent.mjs — the 24/7 day-trading agent, Phase 0 (technical channel, no
// LLM). See docs/DAYTRADER_AGENT.md. Runs continuously on the PC (autostart):
//   • every 15 min: full universe scan for new setups
//   • every  2 min: manage open theses (exits) + re-check forming setups
// Paper only. Persists to /api/argus. Env: LAB_TOKEN (req), LAB_SITE,
// LAB_ARGUS_EQUITY (paper start, default 10000).
import { loadMarket } from "./marketdata.mjs";
import { openThesis, evaluateExit, closeThesisAt, plannedRR, fillPrice, enforceMinStop, MIN_STOP_FRAC, volStatus, pyramidAdd } from "../src/lib/argus/core.js";
import { scan, VOLUME_KINDS } from "../src/lib/argus/scanners.js";
import { buildBrief, diffBrief, renderBrief, parseFearGreed } from "../src/lib/argus/brief.js";
import { deriveLessons, adjustment, sessionOf } from "../src/lib/argus/learn.js";
import { marketOpen } from "../src/lib/argus/hours.js";
import { effectiveHeatCap } from "../src/lib/argus/correlation.js";
import { currentRegime } from "../src/lib/hmmRegime.js";
import { buildReflectionMessages, parseReflection, crystallise, skillsFor, unionSkills } from "../src/lib/argus/reflect.js";
import { wouldHaveHit, invalVerdict, isTerminal, invalPolicy } from "../src/lib/argus/review.js";
import { callArgusLLM, chatOnce } from "../src/lib/argus/llm.js";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
if (!TOKEN) { console.error("LAB_TOKEN is not set."); process.exit(1); }

// Heat = max total risk. Base 10%, rising toward MAX_HEAT (20%) when the open
// positions are UNCORRELATED (a crypto + gold + bond spread diversifies, so a
// bigger risk budget is warranted; three correlated crypto longs stay at base).
const HEAT_CAP = +(process.env.LAB_ARGUS_HEAT || 0.10);
const MAX_HEAT = +(process.env.LAB_ARGUS_MAX_HEAT || 0.20);
const BASE_RISK = +(process.env.LAB_ARGUS_RISK || 0.02);
// Leverage: Argus chooses its OWN leverage per trade (bounded so the stop fires
// before liquidation — core.chooseLeverage), hard-capped at MAX_TRADE_LEV (100×).
// CONCURRENCY is gated by RISK: Argus may open as many trades as it wants until the
// HEAT cap (Σ stop-risk) is reached — margin does NOT limit the book. A generous
// gross-NOTIONAL ceiling (PORTFOLIO_LEV_CAP × equity) is the only extra safety so a
// run of tight-stop trades can't build unbounded exposure. Both tunable.
const MAX_TRADE_LEV = +(process.env.LAB_ARGUS_MAX_TRADE_LEV || 100);
const PORTFOLIO_LEV_CAP = +(process.env.LAB_ARGUS_PORTFOLIO_LEV || 50);
// "Wait for a better entry": rather than chase a momentum setup at the close,
// Argus may park a LIMIT at the retest of the broken level and enter there — but
// only when a pullback is plausible and entering now is a mediocre R:R. A limit
// that isn't filled within this window is stale and abandoned.
const GOOD_RR = +(process.env.LAB_ARGUS_GOOD_RR || 1.6);
const LIMIT_TTL_MS = +(process.env.LAB_ARGUS_LIMIT_TTL_MIN || 45) * 60000;
const DAILY_STOP = +(process.env.LAB_ARGUS_DAILY_STOP || 0.04);
const EQUITY0 = +(process.env.LAB_ARGUS_EQUITY || 10000);
// Phase-1 event channel: LLM reads the alt-data briefing and proposes directional
// biases. Best-effort (free LLM pool is flaky) and opt-out via LAB_ARGUS_LLM=0.
const LLM_ON = process.env.LAB_ARGUS_LLM !== "0";
const EVENT_TTL = +(process.env.LAB_ARGUS_EVENT_TTL_MIN || 240) * 60_000; // biases expire (4h)
// Hermes-style learning: buckets need at least this many closed trades before any
// lesson is allowed to touch sizing (small samples lie). Tunable, conservative.
const LEARN_MIN = +(process.env.LAB_ARGUS_LEARN_MIN || 20);

// How much of its own candidate flow the learning loop is currently REFUSING.
// This is the instrument that says whether learning is tuning the book or
// quietly shutting it down: the anti-freeze guard is per-bucket, so a dozen
// separately-reasonable skips can still add up to "trade nothing" without any
// single one tripping it. When this number is high the problem is not the
// allocation, it is that the entries have no edge to allocate.
const learnGate = { considered: 0, refused: 0, since: Date.now() };
const RVOL_MIN = +(process.env.LAB_ARGUS_RVOL_MIN || 1.1); // breakouts need above-average volume
const PYRAMID = process.env.LAB_ARGUS_PYRAMID !== "0";     // scale into winners (Turtle-style MM)
const PYRAMID_MAX_UNITS = +(process.env.LAB_ARGUS_PYRAMID_UNITS || 4);
const PYRAMID_STEP = +(process.env.LAB_ARGUS_PYRAMID_STEP || 1); // add a unit each R of profit
// Trade duration: hard cap 3 days (a position still open then is force-closed),
// but Argus is a DAY-TRADER at heart — it prefers short, high-conviction setups
// (reaching the same target with a tighter stop = more exposure) over long swing
// holds that hinge on news. The cap is the backstop, not the goal. Tunable.
const MAX_HOLD_MS = +(process.env.LAB_ARGUS_MAX_HOLD_H || 72) * 3600_000;
// Retrospective review of "invalidated" exits: re-examine each early-cut trade ~12h
// and again ~24h later, judge whether cutting was right (would it have hit target or
// the stop?), and LEARN — loosen the invalidation on setups whose cuts kept proving
// premature. Tunable so a test can compress the horizons.
const REVIEW_1_MS = +(process.env.LAB_ARGUS_REVIEW1_H || 12) * 3600_000;
const REVIEW_2_MS = +(process.env.LAB_ARGUS_REVIEW2_H || 24) * 3600_000;
// News-reachable tickers Argus may trade if a catalyst clearly names them, and a
// stock→sector-ETF map so the event channel routes a named single-name catalyst
// to the RIGHT sector (fixes AEP, a UTILITY, being mapped to XLE/energy).
const EVENT_TICKERS = ["USO", "XLE", "XLU", "XLF", "XLK", "XLV", "XLI", "XLP", "XLY", "SMH", "ITA", "GLD", "UNG", "XOP", "SLV", "TLT", "UUP", "GDX"];
const SECTOR_ETF = {
  // utilities
  AEP: "XLU", DUK: "XLU", SO: "XLU", NEE: "XLU", D: "XLU", EXC: "XLU", XEL: "XLU",
  // energy
  XOM: "XLE", CVX: "XLE", COP: "XLE", SLB: "XLE", OXY: "XLE", EOG: "XLE",
  // financials
  JPM: "XLF", BAC: "XLF", WFC: "XLF", GS: "XLF", MS: "XLF", C: "XLF",
  // tech / semis
  AAPL: "XLK", MSFT: "XLK", NVDA: "SMH", AMD: "SMH", AVGO: "SMH", TSM: "SMH", INTC: "SMH", MU: "SMH", QCOM: "SMH",
  // healthcare
  UNH: "XLV", LLY: "XLV", JNJ: "XLV", PFE: "XLV", MRK: "XLV", ABBV: "XLV",
};

// Tradeable universe — Argus decides what looks good across asset classes:
// crypto (Binance, 24/7), US stocks + ETFs (Yahoo, RTH) and futures (Yahoo
// continuous =F, ~23h). Options are intentionally excluded (no chain/greeks/fill
// model yet). Tune LAB_ARGUS_UNIVERSE=crypto,stock,etf,futures to narrow it.
const UNIVERSE_ALL = [
  // crypto
  ...["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "ADAUSDT", "LTCUSDT"]
    .map((s) => ({ id: s, asset: "crypto", symbol: s, cls: "crypto" })),
  // stocks
  ...["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "META", "GOOGL", "AMD", "NFLX", "AVGO", "JPM", "COIN"]
    .map((s) => ({ id: s, asset: "stock", symbol: s, cls: "stock" })),
  // ETFs (Yahoo, same hours/asset as stocks)
  ...["SPY", "QQQ", "IWM", "GLD", "SLV", "USO", "TLT", "XLE", "XLF", "XLK", "XLU", "SMH"]
    .map((s) => ({ id: s, asset: "stock", symbol: s, cls: "etf" })),
  // futures (Yahoo continuous; nearly 24h)
  ...["ES=F", "NQ=F", "YM=F", "CL=F", "GC=F", "SI=F", "NG=F"]
    .map((s) => ({ id: s, asset: "futures", symbol: s, cls: "futures" })),
];
const UNIVERSE_CLASSES = (process.env.LAB_ARGUS_UNIVERSE || "crypto,stock,etf,futures").split(",").map((s) => s.trim());
const UNIVERSE = UNIVERSE_ALL.filter((u) => UNIVERSE_CLASSES.includes(u.cls));

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
let eventFng = null; // latest crypto Fear & Greed reading (shown on the Argus page)
let journal = [];       // Hermes post-mortems, newest first
let skills = [];        // lessons crystallised from repeats — consulted before a trade
let retainedSkills = []; // knowledge kept across a reset (journal cleared, skills survive)
let reflectQueue = [];  // closed trades awaiting their post-mortem
let invalReviews = [];  // pending retrospections of invalidated exits {id,symbol,asset,side,kind,stop,target,exitAt,dueAt,stage}
let invalStats = {};    // learned per-kind tally: { [kind]: { premature, justified, unnecessary } } — survives a reset
let forceClose = new Set(); // thesis ids the dev asked to close now (drained each cycle)
let forceCloseReason = new Map(); // thesis id → the dev's reason for closing early (fed to the post-mortem)
let pendingCommands = []; // raw dev commands drained this cycle, acked once handled
let lastPersistSig = ""; // skip redundant KV writes on the fast loop (write budget)

const openRisk = () => open.reduce((a, t) => a + t.riskAmt, 0);
const openNotional = () => open.reduce((a, t) => a + (t.notional || t.size * t.entry || 0), 0);
const openMargin = () => open.reduce((a, t) => a + (t.margin || (t.size * t.entry) / (t.leverage || 1) || 0), 0);
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
    // Crypto Fear & Greed (alternative.me) — a sentiment input the LLM factors in.
    const fngRaw = await fetch("https://api.alternative.me/fng/?limit=1").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [world, conflicts, disasters, news, telegram] = await Promise.all([get("/api/world"), get("/api/conflicts"), get("/api/disasters"), get("/api/news"), get("/api/telegram")]);
    eventFng = parseFearGreed(fngRaw);
    const brief = buildBrief({ world, conflicts: conflicts?.conflicts, disasters: disasters?.disasters, news, fng: eventFng, osint: telegram?.items });
    brief.deltas = diffBrief(prevBrief, brief);
    prevBrief = brief;
    const ctx = { universe: [...UNIVERSE.map((u) => u.symbol), ...EVENT_TICKERS], open: open.map((o) => o.symbol), sectors: SECTOR_ETF };
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
    // Track the trade's MAX FAVOURABLE / ADVERSE excursion (in R) from the bar's
    // high/low — so the post-mortem can judge whether the TARGET and STOP were well
    // placed: e.g. deep in profit before reversing to a loss → target too far / should
    // have trailed; barely tested before winning → stop wider than needed; ran far
    // past the target → target too tight. Updated before the exit check so the
    // closing bar's excursion counts, and carried onto the closed record via ...th.
    // The TIME of each extreme is recorded alongside it, and that is the whole
    // point of this block rather than a detail. Without it, a trade that ran to
    // +0.8R and then reversed is indistinguishable from one that dipped to −0.8R
    // and then recovered — the pair of magnitudes is identical. The live ledger
    // showed 22 of 68 losers reaching +0.5R before dying at a full stop, and the
    // obvious question (would a break-even stop have saved them, or would it
    // have cost the winners more?) was unanswerable from what was stored.
    const favMove = th.side === "long" ? last5.high - th.entry : th.entry - last5.low;
    const advMove = th.side === "long" ? th.entry - last5.low : last5.high - th.entry;
    if (th.riskAmt > 0) {
      const favR = (Math.max(0, favMove) * th.size) / th.riskAmt;
      const advR = (Math.max(0, advMove) * th.size) / th.riskAmt;
      const at = Number.isFinite(last5.time) ? last5.time * 1000 : Date.now();
      if (favR > (th.maxFavR || 0)) { th.maxFavR = favR; th.maxFavAt = at; }
      if (advR > (th.maxAdvR || 0)) { th.maxAdvR = advR; th.maxAdvAt = at; }
      // Bars seen, so an excursion can be read as "early in the trade" vs "late"
      // without needing the timeframe to reconstruct it.
      th.barsSeen = (th.barsSeen || 0) + 1;
    }
    // Dev "close now" takes priority over the normal stop/target check.
    const devClosed = forceClose.has(th.id);
    const res = devClosed ? closeThesisAt(th, last5.close) : evaluateExit(th, last5, { maxHoldMs: MAX_HOLD_MS });
    if (res) {
      if (devClosed) {
        // Carry the dev's "why" into the post-mortem so Argus learns from the
        // judgement call, not just the P&L of an early close.
        res.devClose = true;
        res.devCloseReason = forceCloseReason.get(th.id) || "";
        forceCloseReason.delete(th.id);
      }
      open = open.filter((o) => o.id !== th.id);
      equity += res.pnl;
      closedToday.push(res);
      ledgerAdd.push(res);
      closedAll.push(res); // feed the learning ledger
      reflectQueue.push(res); // Hermes: every closed trade earns a post-mortem
      if (res.outcome === "invalidated") queueInvalReview(res); // was cutting it right? re-judge at 12h/24h
      if (closedAll.length > 600) closedAll = closedAll.slice(-600);
      console.log(`[${new Date().toISOString()}] CLOSE ${res.symbol} ${res.side} ${res.outcome} R=${res.R.toFixed(2)} pnl=${res.pnl.toFixed(2)} eq=${equity.toFixed(0)}`);
    } else {
      // Still open — stamp the live price + floating (unrealized) P&L so the UI can
      // show current price and the running gain/loss per position (Bug 4).
      const dir = th.side === "long" ? 1 : -1;
      th.currentPrice = last5.close;
      th.unrealizedPnl = (last5.close - th.entry) * th.size * dir;
      th.unrealizedR = th.riskAmt > 0 ? th.unrealizedPnl / th.riskAmt : 0;
      th.lastPoll = Date.now();

      // PYRAMID into a working CONTINUATION trade (Turtle-style MM): add a unit each
      // R of profit and trail the stop so total risk stays inside the original
      // budget — more size on the house's money, never more risk. The rising
      // threshold (units × step) self-spaces the adds; the gross-notional cap still
      // binds. Reversal fades (fixed target) don't pyramid.
      if (PYRAMID && VOLUME_KINDS.has(th.kind) && (th.units || 1) < PYRAMID_MAX_UNITS && th.unrealizedR >= (th.units || 1) * PYRAMID_STEP) {
        const add = pyramidAdd(th, last5.close, { maxUnits: PYRAMID_MAX_UNITS });
        if (add && openNotional() - th.notional + add.notional <= PORTFOLIO_LEV_CAP * equity) {
          Object.assign(th, add);
          console.log(`[${new Date().toISOString()}] PYRAMID ${th.symbol} ${th.side} → unit ${th.units} @${last5.close.toFixed(4)} size ${th.size.toFixed(4)} stop ${th.stop.toFixed(4)} (risk locked ${th.riskAmt.toFixed(0)})`);
        }
      }
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
      const out = await chatOnce(buildReflectionMessages(trade, { recentLessons, devCloseReason: trade.devCloseReason }), { maxTokens: 420 });
      if (!out.ok) { reflectQueue.unshift(trade); break; } // LLM down — retry next cycle
      const entry = parseReflection(out.text, trade);
      if (!entry) continue;
      journal.unshift(entry);
      if (journal.length > 300) journal = journal.slice(0, 300);
      console.log(`[${new Date().toISOString()}] REFLECT ${trade.symbol} ${trade.outcome} ${entry.verdict}: ${entry.lesson || entry.cause}`);
    } catch { reflectQueue.unshift(trade); break; }
  }
  // CRYSTALLISE: a lesson written down repeatedly for the same situation becomes
  // a rule the agent obeys before its next trade of that kind. Union with skills
  // retained across a reset (whose journal entries were cleared) so kept knowledge
  // isn't wiped by a freshly-empty journal.
  skills = unionSkills(retainedSkills, crystallise(journal));
}

/** Queue a retrospection for an invalidated exit: was cutting it right? First look at
 *  exit+12h; a still-open verdict is re-checked at exit+24h. */
function queueInvalReview(res) {
  invalReviews.push({
    id: res.id, symbol: res.symbol, asset: res.asset, side: res.side, kind: res.kind,
    stop: res.stop, target: res.target, exitAt: res.exitAt,
    dueAt: res.exitAt + REVIEW_1_MS, stage: 1,
  });
  if (invalReviews.length > 200) invalReviews = invalReviews.slice(-200);
}

/** Fold a settled review verdict into the learned per-kind tally + annotate the
 *  ledger record so the learning loop and the UI both see it. Returns the annotated
 *  ledger record to re-persist (or null if the record is gone). */
function recordInvalVerdict(r, would) {
  const verdict = invalVerdict(would);
  const s = invalStats[r.kind] || (invalStats[r.kind] = { premature: 0, justified: 0, unnecessary: 0 });
  s[verdict] = (s[verdict] || 0) + 1;
  const c = closedAll.find((x) => x.id === r.id);
  if (c) { c.invalReview = verdict; c.invalWouldHave = would; c.invalReviewedAt = Date.now(); }
  console.log(`[${new Date().toISOString()}] REVIEW ${r.symbol} ${r.side} ${r.kind} invalidation @+${Math.round((Date.now() - r.exitAt) / 3600000)}h → ${verdict} (${would}) · ${r.kind}: ${s.premature}prem/${s.justified}just/${s.unnecessary}none`);
  return c || null;
}

/** Retrospective review pass (full-scan only): judge each due invalidated exit by
 *  replaying the ORIGINAL trade forward over the candles that followed. A terminal
 *  outcome (would-have-won / -lost) settles immediately; an undecided one waits for
 *  the 24h horizon. Learning (invalPolicy) then loosens the invalidation on setups
 *  whose cuts keep proving premature. Returns ledger records to re-persist. */
async function processInvalReviews() {
  const now = Date.now();
  if (!invalReviews.some((r) => r.dueAt <= now)) return [];
  const updates = [];
  const next = [];
  for (const r of invalReviews) {
    if (r.dueAt > now) { next.push(r); continue; }
    const horizonEnd = r.exitAt + (r.stage === 1 ? REVIEW_1_MS : REVIEW_2_MS);
    let window = null;
    try {
      // 5m candles spanning the exit → horizon. 500 bars ≈ 41h of 5m — enough to
      // cover a 24h horizon even with scan-cadence slack; stocks use a day range.
      const ds = await loadMarket({ id: r.symbol, asset: r.asset, symbol: r.symbol, interval: "5m", bars: 500, range: "5d" });
      const all = ds?.candles || [];
      window = all.filter((c) => c.time * 1000 >= r.exitAt && c.time * 1000 <= horizonEnd);
    } catch { /* provider hiccup — retry next cycle */ }
    if (r.asset !== "crypto") await sleep(300); // be gentle on Yahoo
    if (!window || window.length < 3) { next.push(r); continue; } // not enough data yet — keep it
    const would = wouldHaveHit(r.side, r.stop, r.target, window);
    if (r.stage === 1 && !isTerminal(would)) {
      next.push({ ...r, stage: 2, dueAt: r.exitAt + REVIEW_2_MS }); // undecided at 12h → re-judge at 24h
      continue;
    }
    const rec = recordInvalVerdict(r, would);
    if (rec) updates.push(rec);
  }
  invalReviews = next;
  return updates;
}

/** Compact snapshot of the retrospective-review learning for the Argus page. */
function invalReviewSummary() {
  let premature = 0, justified = 0, unnecessary = 0;
  const kinds = [];
  for (const [kind, s] of Object.entries(invalStats)) {
    premature += s.premature || 0; justified += s.justified || 0; unnecessary += s.unnecessary || 0;
    const pol = invalPolicy(s);
    kinds.push({ kind, premature: s.premature || 0, justified: s.justified || 0, unnecessary: s.unnecessary || 0,
      policy: pol.label || "default" });
  }
  kinds.sort((a, b) => (b.premature + b.unnecessary) - (a.premature + a.unnecessary));
  return { premature, justified, unnecessary, pending: invalReviews.length, kinds: kinds.slice(0, 12) };
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// How convinced Argus is of a TECHNICAL setup, before the bias tilts it — from
// the reward:risk and multi-timeframe alignment the scanner already found. This
// drives leverage (higher conviction ⇒ Argus leans in harder, within the caps).
function convictionOf(setup) {
  let c = 0.5;
  const rr = Number.isFinite(setup.plannedR) ? setup.plannedR
    : (setup.entry && setup.stop && setup.target ? plannedRR(setup.side, setup.entry, setup.stop, setup.target) : 1);
  if (rr >= 2.5) c += 0.2; else if (rr >= 1.8) c += 0.1; else if (rr < 1) c -= 0.1;
  if (setup.bias) { // higher-TF regime the scanner tagged
    const aligned = (setup.side === "long" && setup.bias === "up") || (setup.side === "short" && setup.bias === "down");
    const against = (setup.side === "long" && setup.bias === "down") || (setup.side === "short" && setup.bias === "up");
    if (aligned) c += 0.15; else if (against) c -= 0.1;
  }
  return clamp01(c);
}

function tryOpen(inst, setup, halted) {
  if (halted) return;
  if (!marketOpen(inst)) return;                          // never open a closed market
  if (open.some((o) => o.symbol === inst.symbol)) return; // one position per instrument
  const bias = eventBias.get(inst.symbol);

  // Bias is NOT a gate. Argus trades the TECHNICAL setup on its own merits like a
  // real day-trader; the event bias is just ONE weighted input, taken in its parts
  // (side + confidence), not "green good / red bad". It only VETOES on a strong,
  // high-confidence DISAGREEMENT (don't fight a clear fundamental catalyst); a
  // weak or absent bias is effectively ignored. (Even event-named tickers now need
  // only a coherent technical setup, not a bias-matching one.)
  const biasSide = bias?.side; // "long" | "short" | undefined
  const biasConf = clamp01(bias?.confidence ?? 0);
  const opposes = biasSide && biasSide !== setup.side;
  if (opposes && biasConf >= 0.7) {
    console.log(`[${new Date().toISOString()}] SKIP ${inst.symbol} ${setup.side} ${setup.kind} — strong opposing catalyst (${(biasConf * 100) | 0}%): ${(bias.thesis || "").slice(0, 60)}`);
    return;
  }

  // Hermes learning: nudge (or veto) sizing from what the ledger has taught us
  // about this kind of setup. Gentle by construction — mult is hard-clamped and
  // only buckets with ≥ LEARN_MIN closed trades count.
  const evented = biasSide && biasSide === setup.side;
  // The market STATE the trade is being taken in, not just the clock hour. The
  // hidden-Markov model is fitted on the hourly series (5m bars are too noisy to
  // label a regime from) and cached per candle array, so this costs one fit per
  // symbol per reload rather than one per setup.
  const regime = setup._regime ?? null;
  const adj = adjustment(lessons, {
    kind: setup.kind, symbol: inst.symbol, side: setup.side,
    session: sessionOf(Date.now()), source: evented ? "event" : "technical", bias: setup.bias,
    regime,
  }, { minSample: LEARN_MIN });
  learnGate.considered++;
  if (adj.skip) {
    learnGate.refused++;
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
  // Volatility-regime gate (the risk system's "Volatility check"): skip when the
  // current regime is too wild to trade cleanly (whipsaw / gap-through-stop risk),
  // and size DOWN in the elevated band just below the ceiling.
  // The timeframe matters: without it a 5-minute ATR was being judged against a
  // daily ceiling, and the gate never fired once.
  const vol = volStatus(setup.atrPct, inst.asset, setup.timeframe);
  if (!vol.ok) {
    console.log(`[${new Date().toISOString()}] SKIP ${inst.symbol} ${setup.side} ${setup.kind} — ${vol.reason}`);
    return;
  }
  // Relative-volume gate: a breakout / continuation setup on THIN volume tends to
  // fail (no participation behind the move) — skip it. Reversal fades don't need a
  // volume surge, so only VOLUME_KINDS are gated.
  if (VOLUME_KINDS.has(setup.kind) && Number.isFinite(setup.rvol) && setup.rvol < RVOL_MIN) {
    console.log(`[${new Date().toISOString()}] SKIP ${inst.symbol} ${setup.side} ${setup.kind} — thin volume (rvol ${setup.rvol.toFixed(2)} < ${RVOL_MIN})`);
    return;
  }
  const riskPct = BASE_RISK * adj.mult * vol.mult;

  // Conviction = technical setup quality, tilted by an ALIGNED bias (its parts, not
  // a binary; real signals dominate at 0.7 weight), plus a GENTLE nudge from the
  // learned prior (adj.mult−1) so a proven bucket leans in a touch harder and a
  // shaky one eases off — bounded, so learning nudges leverage but never swings it.
  const conviction = clamp01(0.7 * convictionOf(setup) + 0.3 * (0.5 + 0.5 * (evented ? biasConf : opposes ? -biasConf : 0)) + 0.15 * (adj.mult - 1));

  // WAIT FOR A BETTER ENTRY (user request): rather than chase a momentum setup at
  // the close — where the entry sits right on top of the stop and gets shaken out
  // on noise — Argus may park a LIMIT at the retest of the level it just broke and
  // enter THERE, for a better price and a cleaner R:R. Only when a pullback is
  // plausible: there's a retest level on the favourable side, conviction isn't
  // urgent (a high-conviction setup enters now rather than risk missing it), and
  // entering at the current price is only a mediocre R:R. Otherwise: enter directly.
  if (!setup._fromLimit && Number.isFinite(setup.retest) && conviction < 0.85) {
    const fillNow = fillPrice(setup.entry, setup.side, "entry", inst.asset);
    const stopNow = enforceMinStop(fillNow, setup.stop, setup.side, inst.asset);
    const rrNow = plannedRR(setup.side, fillNow, stopNow, setup.target);
    const favourable = setup.side === "long" ? setup.retest < fillNow : setup.retest > fillNow;
    if (rrNow < GOOD_RR && favourable) {
      const limit = setup.retest;
      const stopAtLimit = enforceMinStop(limit, setup.stop, setup.side, inst.asset);
      const rrLimit = plannedRR(setup.side, limit, stopAtLimit, setup.target);
      const bufferOk = Math.abs(limit - stopAtLimit) >= (MIN_STOP_FRAC[inst.asset] ?? 0.002) * limit;
      // Only worth waiting if the retest clearly improves R:R, keeps a real buffer,
      // and is within one stop-distance (a pullback that far is realistic, further is a miss).
      const reachable = Math.abs(fillNow - limit) <= Math.abs(fillNow - stopNow);
      if (rrLimit >= GOOD_RR && bufferOk && reachable) {
        forming = forming.filter((f) => f.symbol !== inst.symbol);
        forming.push({
          symbol: inst.symbol, asset: inst.asset, side: setup.side, kind: setup.kind,
          limit, stop: setup.stop, target: setup.target, bias: setup.bias ?? null,
          evidence: setup.evidence || [], conviction, reason: setup.reason,
          stopDist: Math.abs(limit - stopAtLimit),   // intended risk at the retest (run-away guard)
          expiresAt: Date.now() + LIMIT_TTL_MS, pending: true,
        });
        console.log(`[${new Date().toISOString()}] WAIT ${inst.symbol} ${setup.side} ${setup.kind} — limit @${limit.toFixed(4)} (now ${rrNow.toFixed(2)}R → retest ${rrLimit.toFixed(2)}R): ${setup.reason}`);
        return;
      }
    }
  }

  // Diversification-aware heat: more total risk allowed when this trade is
  // uncorrelated with what's already open.
  // Direction matters: long BTC + short ETH is not the same bet as long + long,
  // and passing bare symbols would have the risk model treat them identically.
  const heatCap = effectiveHeatCap(
    open.map((o) => ({ symbol: o.symbol, side: o.side })),
    { symbol: inst.symbol, side: setup.side }, HEAT_CAP, MAX_HEAT);
  const th = openThesis(
    // `regime` (not `_regime`) so it lands on the closed thesis and the learning
    // loop can bucket by it — the underscore fields are scratch and are stripped.
    { ...setup, symbol: inst.symbol, market: inst.asset, conviction, regime, limitFill: !!setup._fromLimit },
    { equity, openRisk: openRisk(), openMargin: openMargin(), openNotional: openNotional(), asset: inst.asset,
      heatCap, baseRiskPct: riskPct, maxTradeLev: MAX_TRADE_LEV, portfolioLevCap: PORTFOLIO_LEV_CAP, conviction },
  );
  if (th) {
    // Retrospective LEARNING (bidirectional): the 12/24h reviews tune this KIND's
    // invalidation. Premature-heavy → ease or disable the early cut (let the hard stop
    // work); justified-heavy → cut a touch earlier to recover the risk those cuts kept
    // saving. Every tier is reversible as the tally shifts.
    const pol = invalPolicy(invalStats[th.kind]);
    if (pol.disable && th.invalidation != null) {
      th.invalidation = null;
      console.log(`[${new Date().toISOString()}] INVAL-OFF ${th.symbol} ${th.kind} — reviews ruled its cuts premature (${JSON.stringify(invalStats[th.kind])})`);
    } else if (pol.invalMinAdverse) {
      th.invalMinAdverse = pol.invalMinAdverse;
      th.invalConfirmBars = pol.invalConfirmBars;
      if (pol.label) console.log(`[${new Date().toISOString()}] INVAL-${pol.label.toUpperCase()} ${th.symbol} ${th.kind} @${pol.invalMinAdverse}R (${JSON.stringify(invalStats[th.kind])})`);
    }
    if (bias && bias.side === th.side) { // enrich a confirmed setup with its catalyst
      th.catalyst = bias.thesis;
      th.confidence = bias.confidence;
      th.horizon = bias.horizon;
      if (bias.evidence?.length) th.evidence = [...new Set([...(th.evidence || []), ...bias.evidence])].slice(0, 6);
      th.reason = `⚡ ${th.reason}`;
    }
    open.push(th);
    // The risk system's checklist, surfaced on the thesis (Size / Exposure / DD /
    // Volatility / Max-loss → Pass). A trade only reaches here after every gate
    // passed, so this shows WHY it was allowed — auditable, like the reel's slide 5.
    th.riskChecks = {
      pass: true,
      size: true,
      exposure: true, heatUsedPct: +((openRisk() / equity) * 100).toFixed(1), heatCapPct: +(heatCap * 100).toFixed(0),
      drawdown: true,
      volatility: { ok: vol.ok, elevated: !!vol.elevated, label: vol.label },
      volume: { rvol: Number.isFinite(setup.rvol) ? +setup.rvol.toFixed(2) : null, gated: VOLUME_KINDS.has(setup.kind) },
      maxLoss: true, // a daily-loss halt returns at the top of tryOpen, so it's clear here
    };
    forming = forming.filter((f) => f.symbol !== inst.symbol);
    if (adj.mult !== 1) console.log(`[${new Date().toISOString()}] LESSON ${inst.symbol} size ×${adj.mult.toFixed(2)} — ${adj.reasons[0] || ""}`);
    console.log(`[${new Date().toISOString()}] OPEN ${th.symbol} ${th.side} ${th.kind}${th.catalyst ? " [event]" : ""} @${th.entry.toFixed(4)} stop ${th.stop.toFixed(4)} tgt ${th.target.toFixed(4)} risk ${th.riskAmt.toFixed(0)} — ${th.reason}`);
  } else {
    // no heat room → park as forming so it's re-checked on the fast loop
    if (!forming.some((f) => f.symbol === inst.symbol)) forming.push({ symbol: inst.symbol, asset: inst.asset, side: setup.side, kind: setup.kind, reason: "waiting for heat: " + setup.reason });
  }
}

/** A parked LIMIT order (from "wait for a better entry"): if price has pulled back
 *  to the retest level, enter there; if it never came within the window, abandon it.
 *  Returns true when this symbol had a pending limit (so the caller skips a fresh
 *  scan for it — the limit governs the entry until it fills or expires). */
function checkLimits(inst, candle, halted) {
  const idx = forming.findIndex((f) => f.symbol === inst.symbol && f.pending && Number.isFinite(f.limit));
  if (idx < 0) return false;
  const f = forming[idx];
  if (halted || Date.now() > f.expiresAt || open.some((o) => o.symbol === inst.symbol)) {
    forming.splice(idx, 1);
    if (!halted && !open.some((o) => o.symbol === inst.symbol)) console.log(`[${new Date().toISOString()}] EXPIRE-LIMIT ${inst.symbol} ${f.side} ${f.kind} @${f.limit.toFixed(4)} — no pullback`);
    return true;
  }
  // Filled if the bar traded through the limit (low ≤ limit for a long, high ≥ for a short).
  const hit = f.side === "long" ? (candle.low ?? candle.close) <= f.limit : (candle.high ?? candle.close) >= f.limit;
  if (!hit) return true; // still waiting
  // Run-away guard: a retest should fill NEAR the level, not after price has already
  // pushed well past it toward the stop (that's a failed retest — we'd be born hugging
  // the SL, entering into a move going against us). If the bar CLOSED more than 30% of
  // the way to the stop beyond the limit, the retest failed — abandon it.
  const overshoot = f.side === "long" ? f.limit - candle.close : candle.close - f.limit; // toward the stop
  if (f.stopDist > 0 && overshoot > 0.3 * f.stopDist) {
    forming.splice(idx, 1);
    console.log(`[${new Date().toISOString()}] ABANDON-LIMIT ${inst.symbol} ${f.side} ${f.kind} @${f.limit.toFixed(4)} — retest ran ${(overshoot / f.stopDist * 100).toFixed(0)}% to the stop`);
    return true;
  }
  forming.splice(idx, 1);
  tryOpen(inst, {
    symbol: inst.symbol, side: f.side, kind: f.kind, entry: f.limit, stop: f.stop, target: f.target,
    bias: f.bias, evidence: f.evidence, conviction: f.conviction, reason: `retest fill — ${f.reason}`, _fromLimit: true,
  }, halted);
  return true;
}

/** Conflict handler (Bug 5A): a fresh, confident OPPOSING catalyst on a symbol we
 *  already hold closes that position — Argus never holds a long into a clear short
 *  signal for the same asset (and vice-versa). The dev-close path does the fill. */
function handleConflicts() {
  for (const th of open) {
    const bias = eventBias.get(th.symbol);
    if (!bias || bias.side === th.side || forceClose.has(th.id)) continue;
    if (clamp01(bias.confidence ?? 0) >= 0.6) {
      forceClose.add(th.id);
      forceCloseReason.set(th.id, `opposing catalyst (${((bias.confidence || 0) * 100) | 0}%): ${(bias.thesis || "").slice(0, 120)}`);
      console.log(`[${new Date().toISOString()}] CONFLICT ${th.symbol} ${th.side} vs ${bias.side} bias → close`);
    }
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
      if (c.reason) forceCloseReason.set(c.id, String(c.reason).slice(0, 200));
    } else if (c.type === "cancel") {
      const before = forming.length;
      forming = forming.filter((f) => f.symbol !== c.id);
      if (eventBias.has(c.id)) eventBias.delete(c.id);
      if (forming.length !== before || eventBias.size) console.log(`[${new Date().toISOString()}] CANCEL ${c.id} (dev)`);
    } else if (c.type === "reset") {
      await doReset("dev");
    }
  }
}

/** Ack the commands we've now carried out so the queue clears. A close is only
 *  acked once its thesis is actually gone from `open`; a cancel is immediate. */
async function ackCommands() {
  if (!pendingCommands.length) return;
  const ack = [];
  for (const c of pendingCommands) {
    if (c.type === "cancel" || c.type === "reset") ack.push(c.id);
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
      handleConflicts(); // close positions a fresh opposing catalyst now argues against
      await runReflections();
      const reviewed = await processInvalReviews(); // judge due invalidated exits (12h/24h) → learn
      for (const rec of reviewed) ledgerAdd.push(rec); // re-persist the annotated ledger records
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
      // A parked limit ("wait for a better entry") governs this symbol until it
      // fills or expires — if one is pending, don't also open a fresh market entry.
      const limitPending = checkLimits(inst, tf.c5[tf.c5.length - 1], halted);
      // Scan for new / re-check forming: both use the same scan; the fast loop
      // catches a forming setup the moment it triggers ("watch until entry").
      if (!limitPending && tf.c15 && tf.c1h) {
        const { triggered } = scan(tf);
        // Label the market state ONCE per symbol per reload and stamp it on every
        // setup. Fitted on the HOURLY series: a hidden-Markov regime read off 5m
        // bars is mostly labelling noise, and the thing we want to bucket by is
        // the state the trade lives in, not the state of the trigger bar.
        let regime = null;
        try { regime = currentRegime(tf.c1h, { K: 3 }); } catch { /* not enough history */ }
        for (const s of triggered) s._regime = regime;
        // Trade only the BEST — and "best" means best EXPECTED value, not just the
        // prettiest chart. Base quality = setup strength × reward:risk, then tilted
        // by what the ledger has TAUGHT us about this bucket (learn.js sizing mult,
        // 0.5–1.25): a kind/symbol/side with proven positive expectancy outranks an
        // equally-pretty setup from a bucket that keeps losing. So the one slot per
        // symbol goes to the highest expected value.
        for (const s of triggered) {
          const a = adjustment(lessons, {
            kind: s.kind, symbol: inst.symbol, side: s.side,
            session: sessionOf(Date.now()), source: "technical", bias: s.bias,
            regime: s._regime ?? null,
          }, { minSample: LEARN_MIN });
          s._rank = (s.strength ?? 0.5) * (s.rMult ?? 2) * a.mult;
        }
        triggered.sort((a, b) => (b._rank ?? 0) - (a._rank ?? 0));
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
    state: (() => {
      const unrealized = open.reduce((a, t) => a + (t.unrealizedPnl || 0), 0);
      return {
        equity,                                 // realized cash equity
        markEquity: equity + unrealized,        // incl. floating P&L on open positions
        unrealized,                             // total floating P&L right now
        open: open.length, forming: forming.length,
        heatPct: openRisk() / equity,           // Σ stop-risk / equity (Bug 2 — the real number)
        heatCapPct: effectiveHeatCap(open.map((o) => ({ symbol: o.symbol, side: o.side })), null, HEAT_CAP, MAX_HEAT),
        heatBasePct: HEAT_CAP, heatMaxPct: MAX_HEAT,
        portfolioLev: openNotional() / equity,  // Σ notional / equity (Bug 1 — true portfolio leverage)
        portfolioLevCap: PORTFOLIO_LEV_CAP,
        marginUsed: openMargin(), marginPct: openMargin() / equity,
        learnRefusedPct: learnGate.considered ? learnGate.refused / learnGate.considered * 100 : 0,
        learnConsidered: learnGate.considered,
        dayPnl: extra.dailyPnl,                 // realized today
        dayPnlTotal: extra.dailyPnl + unrealized, // realized + floating (what the top-bar shows)
        halted: extra.halted, universe: activeUniverse().length, events, fng: eventFng,
        skills: skills.slice(0, 8),
        lessons: lessons.slice(0, 8).map((l) => ({ text: l.text, verdict: l.verdict, n: l.n })),
        // Retrospective-review learning, surfaced for the Argus page: how many
        // invalidated exits each verdict, which kinds now cut later / not at all.
        invalReview: invalReviewSummary(),
      };
    })(),
    theses: open,
    ledgerAdd,
    journal: journal.slice(0, 60),   // Hermes post-mortems (newest first)
    skills,                          // rules crystallised from repeated lessons
    retainedSkills,                  // knowledge kept across a reset (survives an empty journal)
    invalReviews: invalReviews.slice(-200), // pending 12h/24h retrospections
    invalStats,                      // learned per-kind invalidation tally (survives a reset)
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
    if (Array.isArray(j.retainedSkills)) retainedSkills = j.retainedSkills;
    if (j.invalStats && typeof j.invalStats === "object") invalStats = j.invalStats;
    if (Array.isArray(j.invalReviews)) invalReviews = j.invalReviews;
    // Backfill: any invalidated close still without a review verdict — and not
    // already queued — gets one, so the retrospection covers the current book too.
    const queued = new Set(invalReviews.map((r) => r.id));
    for (const c of closedAll) {
      if (c.outcome === "invalidated" && !c.invalReview && !queued.has(c.id) && c.exitAt) {
        invalReviews.push({ id: c.id, symbol: c.symbol, asset: c.asset, side: c.side, kind: c.kind,
          stop: c.stop, target: c.target, exitAt: c.exitAt, dueAt: c.exitAt + REVIEW_1_MS, stage: 1 });
      }
    }
    for (const e of j.state?.events || []) { // restore fresh event biases across restarts
      if (Date.now() - (e.at || 0) < EVENT_TTL) eventBias.set(e.symbol, { side: e.side, thesis: e.thesis, confidence: e.confidence, evidence: [], horizon: e.horizon, at: e.at, model: e.model });
    }
    equityDayStart = equity;
    console.log(`hydrated: eq ${equity.toFixed(0)}, ${open.length} open theses, ${eventBias.size} event-bias, ${closedAll.length} closed → ${lessons.length} lessons, ${journal.length} reflections → ${skills.length} skills`);
  } catch { /* fresh start */ }
}

await hydrate();

// One-shot reset: money + track record (equity, open book, ledger, journal) go
// back to the $10k start, but the crystallised TECHNICAL SKILLS are kept so the
// learning survives. Triggered two ways: LAB_ARGUS_RESET=1 on boot, or a dev
// "reset" command drained at runtime (the Argus page's "Reset to $10k" button).
async function doReset(source) {
  const b = { j: journal.length, s: skills.length };
  retainedSkills = unionSkills(retainedSkills, crystallise(journal)); // keep the knowledge
  journal = [];
  skills = retainedSkills.slice();
  equity = EQUITY0; equityDayStart = EQUITY0;
  open = []; forming = []; closedAll = []; closedToday = []; reflectQueue = [];
  invalReviews = []; // pending retrospections reference the wiped book — drop them (invalStats KEPT: learned)
  forceClose = new Set(); forceCloseReason = new Map();
  lessons = deriveLessons(closedAll, { minSample: LEARN_MIN });
  eventBias = new Map();
  console.log(`[${new Date().toISOString()}] RESET (${source}) → ${EQUITY0}: cleared ${b.j} journal + book + ledger, kept ${retainedSkills.length} skills`);
  await persist([], { dailyPnl: 0, halted: false }); // reset state + theses:[] + empty journal + retained skills
  // persist only APPENDS the ledger — replace it explicitly so the track record starts at 0.
  try {
    await fetch(`${SITE}/api/argus`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, ledgerReplace: [] }),
    });
  } catch { /* offline — harmless */ }
}

if (process.env.LAB_ARGUS_RESET === "1") await doReset("env");
// Near-instant dev commands: a light 15s loop that drains the queue and closes a
// commanded position at the LIVE price right away, instead of waiting up to 2 min
// for the next scan. Shares the cycleRunning mutex so it never races a scan.
async function runCommandsFast() {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    await drainCommands(); // sets forceClose + performs cancels immediately
    if (forceClose.size) {
      const ledgerAdd = [];
      for (const th of open.filter((o) => forceClose.has(o.id))) {
        let price = th.entry;
        try {
          // loadMarket needs ≥400 bars, so pull 500× 1m (one call) and take the
          // last close as the live price.
          const ds = await loadMarket({ id: th.symbol, asset: th.asset, symbol: th.symbol, interval: "1m", bars: 500, range: "1d" });
          const last = ds?.candles?.[ds.candles.length - 1];
          if (last) price = last.close;
        } catch { /* fall back to entry */ }
        const res = closeThesisAt(th, price);
        open = open.filter((o) => o.id !== th.id);
        equity += res.pnl; closedToday.push(res); ledgerAdd.push(res); closedAll.push(res); reflectQueue.push(res);
        forceClose.delete(th.id);
        console.log(`[${new Date().toISOString()}] CLOSE (dev·instant) ${res.symbol} ${res.outcome} R=${res.R.toFixed(2)} pnl=${res.pnl.toFixed(2)} eq=${equity.toFixed(0)}`);
      }
      if (ledgerAdd.length) await persist(ledgerAdd, { halted: false, dailyPnl: closedToday.reduce((a, c) => a + c.pnl, 0) });
    }
    await ackCommands();
  } catch (e) { console.error(`[${new Date().toISOString()}] fast-commands failed: ${e.message}`); }
  finally { cycleRunning = false; }
}

setInterval(() => cycle(true), 15 * 60_000);
setInterval(() => cycle(false), 2 * 60_000);
setInterval(runCommandsFast, 15_000);
cycle(true);
console.log(`Argus running — universe ${UNIVERSE.length} core (+${EVENT_TICKERS.length} event) · event-channel ${LLM_ON ? "on" : "off"} · heat ${HEAT_CAP * 100}% cap / ${BASE_RISK * 100}% base · daily stop ${DAILY_STOP * 100}% · paper eq ${EQUITY0}`);
