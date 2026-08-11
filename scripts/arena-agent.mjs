// arena-agent.mjs — drives the live paper-trading arena.
//
// Connects to Binance's public bookTicker stream (best bid/ask plus the size
// resting on each), fits the micro-price estimator on what it has seen, trades
// the strategies on paper, and pushes the state to /api/arena.
//
// Run:  node scripts/arena-agent.mjs
// Env:  DEV_ACCESS_TOKEN (required to push), ARENA_API (default production),
//       ARENA_SYMBOLS (default BTCUSDT,ETHUSDT), ARENA_DRY=1 to run without pushing.
//
// Nothing here touches real money and no API key is involved — bookTicker is a
// public stream. The point is to find out whether these strategies work at all
// before they are ever taken seriously, which is the one thing a backtest
// cannot tell us about an order-book signal.

import {
  collectTransitions, fitMicroprice, microprice, weightedMid, imbalance,
} from "../src/lib/microprice.js";
import {
  openPosition, closePosition, bracketExit, judgeArena, ARENA_RULES,
} from "../src/lib/arena.js";

const API = process.env.ARENA_API || "https://quant.mmmxcix.com/api/arena";
const TOKEN = process.env.DEV_ACCESS_TOKEN || "";
const DRY = process.env.ARENA_DRY === "1";
const SYMBOLS = (process.env.ARENA_SYMBOLS || "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim()).filter(Boolean);

const STAKE = 1000;            // paper stake per trade, quote currency
const SAMPLE_MS = 250;         // how often the book is sampled into the model
const REFIT_EVERY = 4000;      // samples between refits
const MIN_SAMPLES = 6000;      // before the first fit is attempted
const PUSH_MS = 30_000;
const BUFFER = 40_000;         // observations kept per symbol

// ── What is actually being tested ────────────────────────────────────────────
// A first version of this agent traded the micro-price by CROSSING the spread,
// and in a dry run it never opened a single position. That was correct
// behaviour and a useful result: on BTCUSDT the spread is one tick ($0.01)
// while a 0.1% taker fee costs ~$200 per round trip at $100k. No sub-tick
// order-book signal can ever repay that. The micro-price is not a taking
// signal — it is Stoikov's market-MAKING signal, and its job is to tell a
// quoter which side is about to run him over.
//
// So the arena runs two kinds of evidence side by side:
//
//  1. A PREDICTION SCOREBOARD (fee-independent, the real test of the estimator):
//     out-of-sample, does mid + G* forecast the mid H seconds out better than
//     the mid or the weighted mid? This is a fact about the market, not about
//     anyone's fee tier.
//
//  2. A market-making PAPER LEDGER at a stated fee, where a strategy quotes
//     both sides and earns the spread while the micro-price skews its quotes
//     away from the side about to trade through it.
const HORIZON_MS = 5000;       // scoreboard forecast horizon
const MAKER_FEE = Number(process.env.ARENA_MAKER_FEE ?? 0.0002); // 2bps, a realistic maker tier
const QUOTE_TICKS = 1;         // how far outside the fair price we quote
const REQUOTE_MS = 2000;       // how long a resting quote stays where it was placed

const STRATEGIES = [
  {
    id: "microprice",
    label: "Micro-price maker",
    description: "Quotes both sides around Stoikov's micro-price, so the quotes lean away from the side the book says is about to trade. Earns the spread; loses when the market runs through it.",
    fair: (book, model) => microprice(book, model).price,
    needsModel: true,
  },
  {
    id: "midmaker",
    label: "Mid maker (control)",
    description: "Identical quoting, centred on the plain mid. Present so the micro-price has something honest to beat — if it cannot, the estimator is not earning its complexity.",
    fair: (book) => (book.bid + book.ask) / 2,
    needsModel: false,
  },
];

// ── Live book ────────────────────────────────────────────────────────────────
const state = new Map();   // symbol → { book, obs[], model, tick, sinceFit }

async function tickSize(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`);
    const j = await r.json();
    const f = j?.symbols?.[0]?.filters?.find((x) => x.filterType === "PRICE_FILTER");
    const t = Number(f?.tickSize);
    return t > 0 ? t : null;
  } catch { return null; }
}

function connect(symbol) {
  const url = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@bookTicker`;
  let ws;
  try { ws = new WebSocket(url); } catch (e) { console.error(`[${symbol}] socket failed:`, e.message); return; }
  ws.addEventListener("message", (ev) => {
    try {
      const d = JSON.parse(ev.data);
      const s = state.get(symbol);
      if (!s) return;
      s.book = { bid: +d.b, ask: +d.a, bidSize: +d.B, askSize: +d.A, at: Date.now() };
    } catch { /* malformed frame — skip */ }
  });
  ws.addEventListener("close", () => {
    console.warn(`[${symbol}] stream closed, reconnecting in 5s`);
    setTimeout(() => connect(symbol), 5000);
  });
  ws.addEventListener("error", () => { try { ws.close(); } catch { /* already gone */ } });
}

// ── Paper trading ────────────────────────────────────────────────────────────
const entries = new Map();   // `${strategy}:${symbol}` → entry

function entryFor(strat, symbol) {
  const key = `${strat.id}:${symbol}`;
  if (!entries.has(key)) {
    entries.set(key, {
      id: key, label: `${strat.label} · ${symbol}`, description: strat.description,
      symbol, status: "learning", startedAt: Date.now(), ledger: [], quotes: null,
    });
  }
  return entries.get(key);
}

/**
 * Market-making step. We hold at most one paper position per strategy.
 *
 * FLAT: quote a bid at fair − δ and an ask at fair + δ. A resting bid is filled
 * when the market's best ASK falls to it (someone sells into us) — an
 * approximation that ignores queue position, so it is optimistic, and that is
 * stated on the page rather than buried here.
 *
 * IN A POSITION: quote the other side to get flat again, and cut the position
 * if the market moves far enough against it that waiting is just hoping.
 */
function step(symbol) {
  const s = state.get(symbol);
  if (!s?.book) return;
  const book = s.book;
  if (!(book.bid > 0) || !(book.ask > book.bid)) return;
  const tick = s.tick;

  for (const strat of STRATEGIES) {
    const e = entryFor(strat, symbol);
    if (e.status === "evicted") continue;
    if (strat.needsModel && !s.model) continue;

    const fair = strat.fair(book, s.model);
    if (!Number.isFinite(fair)) continue;
    const open = e.ledger.find((t) => t.state === "open");

    if (open) {
      // Hard stop first — an inventory that keeps running is how a maker dies.
      const x = bracketExit(open, book);
      if (x) { Object.assign(open, closePosition(open, x.price, x.reason)); continue; }
      // Passive exit: a long is unwound by SELLING, so our ask sits at fair + δ
      // and fills when the market's best bid reaches it.
      if (open.side === "long") {
        const quote = fair + QUOTE_TICKS * tick;
        if (book.bid >= quote) Object.assign(open, closePosition(open, quote, "unwound"));
      } else {
        const quote = fair - QUOTE_TICKS * tick;
        if (book.ask <= quote) Object.assign(open, closePosition(open, quote, "unwound"));
      }
      continue;
    }

    // Flat: we have two RESTING quotes. They must keep their price between
    // requotes — recomputing them from the current book every pass makes them
    // chase the market and they can never be crossed, which is exactly why an
    // earlier version of this loop reported zero fills for minutes on end.
    if (!e.quotes || Date.now() - e.quotes.at > REQUOTE_MS) {
      e.quotes = { bid: fair - QUOTE_TICKS * tick, ask: fair + QUOTE_TICKS * tick, at: Date.now() };
      continue;                       // a quote cannot fill in the instant it is placed
    }
    let side = null, px = null;
    if (book.ask <= e.quotes.bid) { side = "long"; px = e.quotes.bid; }
    else if (book.bid >= e.quotes.ask) { side = "short"; px = e.quotes.ask; }
    if (!side) continue;
    e.quotes = null;                  // filled — the pair is pulled

    // The stop is the inventory limit, not a price prediction: a maker that
    // will not cut a losing position is running a martingale.
    const dist = Math.max(px * 0.0015, (book.ask - book.bid) * 8);
    const pos = openPosition({
      strategy: strat.id, symbol, side, price: px, stake: STAKE,
      stop: side === "long" ? px - dist : px + dist,
      target: side === "long" ? px + dist * 2 : px - dist * 2,
    });
    if (pos) { pos.fees = STAKE * MAKER_FEE; e.ledger.push(pos); }
  }
}

// ── Prediction scoreboard ────────────────────────────────────────────────────
// The fee-independent evidence. Every sample is queued with the mid at that
// moment and the three forecasts; HORIZON_MS later the realised mid settles it.
function scoreStep(symbol) {
  const s = state.get(symbol);
  if (!s?.book) return;
  const now = Date.now();
  const mid = (s.book.bid + s.book.ask) / 2;

  while (s.pending.length && now - s.pending[0].at >= HORIZON_MS) {
    const p = s.pending.shift();
    s.score.n++;
    s.score.mid += (mid - p.mid) ** 2;
    s.score.wm += (mid - p.wm) ** 2;
    if (Number.isFinite(p.mp)) { s.score.mp += (mid - p.mp) ** 2; s.score.mpN++; }
  }
  if (s.pending.length < 500) {
    s.pending.push({
      at: now, mid,
      wm: weightedMid(s.book.bid, s.book.ask, s.book.bidSize, s.book.askSize),
      mp: s.model ? microprice(s.book, s.model).price : NaN,
    });
  }
}

function sample(symbol) {
  const s = state.get(symbol);
  if (!s?.book || !s.tick) return;
  s.obs.push({ ...s.book });
  if (s.obs.length > BUFFER) s.obs.splice(0, s.obs.length - BUFFER);
  s.sinceFit++;
  if (s.obs.length >= MIN_SAMPLES && s.sinceFit >= REFIT_EVERY) {
    s.sinceFit = 0;
    const counts = collectTransitions(s.obs, s.tick, { imbBuckets: 8, maxSpreadTicks: 3 });
    const m = fitMicroprice(counts);
    if (m) {
      s.model = m;
      s.fittedAt = Date.now();
      console.log(`[${symbol}] refit: coverage ${(m.coverage * 100).toFixed(0)}%, `
        + `adj ${m.adj.map((a) => (a / s.tick).toFixed(1)).join("/")} ticks`);
    } else {
      console.log(`[${symbol}] refit declined (not enough coverage) — still on the weighted mid`);
    }
  }
}

async function push() {
  const judged = judgeArena([...entries.values()], { now: Date.now() });
  for (const e of judged) entries.set(e.id, e);
  for (const e of judged) {
    if (e.status === "evicted" && !e.reported) {
      e.reported = true;
      console.log(`EVICTED ${e.id}: ${e.evictReason}`);
    }
  }
  const s = state.get(SYMBOLS[0]);
  const book = s?.book ? {
    symbol: SYMBOLS[0], bid: s.book.bid, ask: s.book.ask,
    micro: s.model ? microprice(s.book, s.model).price : weightedMid(s.book.bid, s.book.ask, s.book.bidSize, s.book.askSize),
    at: s.book.at,
  } : null;

  // The scoreboard travels with the state — it is the evidence that does not
  // depend on anyone's fee tier.
  const scores = [...state.entries()].map(([sym, st]) => {
    const rmse = (sse, n) => (n > 0 ? Math.sqrt(sse / n) / st.tick : null);
    return {
      symbol: sym, n: st.score.n, horizonMs: HORIZON_MS,
      midTicks: rmse(st.score.mid, st.score.n),
      weightedTicks: rmse(st.score.wm, st.score.n),
      microTicks: rmse(st.score.mp, st.score.mpN),
      modelCoverage: st.model?.coverage ?? 0,
    };
  });
  for (const sc of scores) {
    if (sc.n > 200) {
      console.log(`[${sc.symbol}] forecast RMSE over ${(HORIZON_MS / 1000)}s (${sc.n} samples): `
        + `mid ${sc.midTicks?.toFixed(3)} | weighted ${sc.weightedTicks?.toFixed(3)} `
        + `| micro ${sc.microTicks == null ? "n/a" : sc.microTicks.toFixed(3)} ticks`);
    }
  }

  const summary = judged.map((e) => {
    const st = e.verdict?.stats;
    return `${e.id} ${e.status}${st?.n ? ` n=${st.n} avgR=${st.avgR.toFixed(2)}` : ""}`;
  }).join(" | ");
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${summary || "warming up"}`);

  if (DRY || !TOKEN) return;
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, entries: judged, book, scores }),
    });
    if (!r.ok) console.error("push failed:", r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.error("push error:", e.message); }
}

async function main() {
  if (!TOKEN && !DRY) {
    console.error("DEV_ACCESS_TOKEN is not set — run with ARENA_DRY=1 to trade locally without pushing.");
    process.exit(1);
  }
  console.log(`arena: ${SYMBOLS.join(", ")} · stake ${STAKE} · evict at t<=${ARENA_RULES.evictTStat} after ${ARENA_RULES.minTrades} trades`);
  for (const sym of SYMBOLS) {
    const tick = await tickSize(sym);
    if (!tick) { console.error(`[${sym}] no tick size — skipping`); continue; }
    state.set(sym, { book: null, obs: [], model: null, tick, sinceFit: 0,
      pending: [], score: { n: 0, mid: 0, wm: 0, mp: 0, mpN: 0 } });
    connect(sym);
    console.log(`[${sym}] tick ${tick} — connected`);
  }
  setInterval(() => { for (const s of state.keys()) { sample(s); scoreStep(s); } }, SAMPLE_MS);
  setInterval(() => { for (const s of state.keys()) step(s); }, 200);
  setInterval(push, PUSH_MS);
}

main().catch((e) => { console.error(e); process.exit(1); });
