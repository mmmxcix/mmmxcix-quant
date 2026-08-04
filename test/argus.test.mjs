// Regression tests for the Argus day-trading core + scanners (Phase 0). Pure
// logic, run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sizePosition, fillPrice, openThesis, evaluateExit, ledgerStats, tradeR, closeThesisAt, chooseLeverage, liquidationPrice, plannedRR, enforceMinStop } from "../src/lib/argus/core.js";
import { breakout, meanReversion, scan } from "../src/lib/argus/scanners.js";

const bar = (o, h, l, c, v = 1000, t = 0) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });
// A flat range of `n` bars around `mid` with small wicks.
const flat = (n, mid, wick = 0.3) => Array.from({ length: n }, (_, i) => bar(mid, mid + wick, mid - wick, mid, 1000, i));

test("heat sizing: full base risk when empty, shrinks with open risk, null when full", () => {
  const eq = 10000;
  const a = sizePosition({ equity: eq, entry: 100, stop: 98, openRisk: 0 });      // 2% = $200 all-in risk
  assert.ok(Math.abs(a.riskAmt - 200) < 1e-6, "first trade risks the full 2% budget (all-in)");
  // Size is set on the EFFECTIVE stop distance (stop dist + exit slippage), so it's
  // a touch below the naive 200/2 = 100 — that headroom is the exit spread/fee.
  assert.ok(a.size < 100 && a.size > 96, "size discounted for exit slippage");
  const b = sizePosition({ equity: eq, entry: 100, stop: 98, openRisk: 500 });    // heat 6%=600, room 100
  assert.ok(Math.abs(b.riskAmt - 100) < 1e-6, "late trade shrinks to remaining heat");
  const c = sizePosition({ equity: eq, entry: 100, stop: 98, openRisk: 600 });    // heat full
  assert.equal(c, null, "no room → null (park in watch-mode)");
});

test("capital gate: committed margin (total notional / leverage) stays ≤ equity", () => {
  // Tiny stop → risk-based size is huge; the account budget (maxLeverage × equity)
  // caps the notional. One trade may use the WHOLE budget (all-in).
  const a = sizePosition({ equity: 10000, entry: 100, stop: 99.9, openRisk: 0, maxLeverage: 10 });
  assert.ok(a.size * 100 <= 10 * 10000 + 1e-6, "notional ≤ maxLeverage × equity");
  assert.ok(a.riskAmt <= 200 + 1e-6, "risk still bounded by the 2% target");
  // Remaining budget: with 90k of 100k already open, only 10k notional room left.
  const b = sizePosition({ equity: 10000, entry: 100, stop: 98, openNotional: 90000, maxLeverage: 10 });
  assert.ok(b.size * 100 <= 10000 + 1e-6, "new notional fits the remaining budget");
  // Budget full → null.
  const full = sizePosition({ equity: 10000, entry: 100, stop: 98, openNotional: 100000, maxLeverage: 10 });
  assert.equal(full, null, "capital fully committed → null");
});

test("leverage is a free, situational choice across 1..100x, capped only by safety", () => {
  // A high-conviction crypto setup with a tight (noise-floor) stop can now lean in
  // HARD — well above the old 20x wall — because safeMax leaves room and the user cap
  // is 100x. Argus is free.
  const cryptoStrong = chooseLeverage(100, 0.2, { conviction: 0.95, asset: "crypto", rr: 3, maxTradeLev: 100 });
  assert.ok(cryptoStrong > 20 && cryptoStrong <= 100, `strong crypto leans in past 20x (got ${cryptoStrong})`);
  // A rich reward:risk presses it harder than a bare 2:1 at the same conviction.
  const cryptoLowRR = chooseLeverage(100, 0.2, { conviction: 0.95, asset: "crypto", rr: 2, maxTradeLev: 100 });
  assert.ok(cryptoStrong >= cryptoLowRR, "higher R:R → at least as much leverage");
  // Conviction is the main dial: a weak setup stays small even with room to spare.
  const weak = chooseLeverage(100, 0.2, { conviction: 0.4, asset: "crypto", maxTradeLev: 100 });
  assert.ok(weak < cryptoStrong && weak >= 1, `weak setup stays modest (got ${weak})`);
  // It genuinely VARIES (not the old fixed 9x): different conviction → different lev.
  assert.notEqual(weak, cryptoStrong, "leverage is not a fixed bucket");
  // HARD safety: on a WIDE stop, safeMax caps leverage so liquidation stays beyond it.
  const lev = chooseLeverage(100, 2, { conviction: 1, asset: "crypto", rr: 5, maxTradeLev: 100 });
  const liq = liquidationPrice(100, "long", lev);
  assert.ok(liq < 100 && liq < 98, `liq below entry and beyond a 98 stop even at max desire (lev ${lev})`);
});

test("enforceMinStop widens an absurdly tight stop to the asset noise floor", () => {
  // A 0.017% BTC stop is noise → widened to ≥ 0.4% (crypto floor).
  const s = enforceMinStop(63563, 63552.65, "long", "crypto");
  assert.ok(63563 - s >= 63563 * 0.004 - 1e-6, "crypto stop widened to ≥ 0.4%");
  // A wide-enough stop is left alone.
  assert.equal(enforceMinStop(100, 98, "long", "crypto"), 98, "healthy stop untouched");
  // Short side widens upward.
  assert.ok(enforceMinStop(100, 100.01, "short", "crypto") > 100, "short tight stop widened up");
});

test("margin ≤ equity, portfolio-notional ceiling, and per-trade leverage returned", () => {
  const s = sizePosition({ equity: 10000, entry: 100, stop: 99.5, openRisk: 0, portfolioLevCap: 20, maxTradeLev: 100 });
  assert.ok(s.margin <= 10000 + 1e-6, "margin never exceeds equity");
  assert.ok(s.notional <= 20 * 10000 + 1e-6, "notional within the portfolio ceiling");
  assert.ok(s.leverage >= 1 && s.leverage <= 100, "sane leverage");
  assert.ok(Math.abs(s.margin - s.notional / s.leverage) < 1e-6, "margin = notional / leverage");
  // Margin budget already used up → new trade can't post margin → null (via notional room 0 or margin 0).
  const capped = sizePosition({ equity: 10000, entry: 100, stop: 98, openMargin: 10000, openNotional: 200000, portfolioLevCap: 20 });
  assert.equal(capped, null, "no margin/notional room → null");
});

test("plannedRR is side-aware and matches the levels (Bug 3)", () => {
  // SOLUSDT example: entry 74.1545, target 75.05, stop 73.141 → real R ≈ 0.88, not 1.9.
  const r = plannedRR("long", 74.1545, 73.141, 75.05);
  assert.ok(Math.abs(r - 0.884) < 0.01, `long R ≈ 0.88 (got ${r.toFixed(3)})`);
  const rs = plannedRR("short", 100, 102, 96); // risk 2, reward 4 → 2R
  assert.ok(Math.abs(rs - 2) < 1e-9, "short R = 2");
});

test("fill price moves against the trader on entry and exit", () => {
  assert.ok(fillPrice(100, "long", "entry", "crypto") > 100, "long entry pays up");
  assert.ok(fillPrice(100, "long", "exit", "crypto") < 100, "long exit gets less");
  assert.ok(fillPrice(100, "short", "entry", "crypto") < 100, "short entry sells lower");
});

test("a LIMIT (retest) fill takes the limit price, not adverse slippage", () => {
  // Market short: entry slips BELOW the level (sells lower). A limit short must fill
  // AT the level — otherwise the entry is drawn where the market never traded.
  const mkt = openThesis({ symbol: "BNBUSDT", market: "crypto", side: "short", kind: "breakout", timeframe: "15m", entry: 588.02, stop: 590.5, target: 583.85, reason: "x" },
    { equity: 10000, openRisk: 0, asset: "crypto", heatCap: 0.10, baseRiskPct: 0.02 });
  const lim = openThesis({ symbol: "BNBUSDT", market: "crypto", side: "short", kind: "breakout", timeframe: "15m", entry: 588.02, stop: 590.5, target: 583.85, reason: "x", limitFill: true },
    { equity: 10000, openRisk: 0, asset: "crypto", heatCap: 0.10, baseRiskPct: 0.02 });
  assert.ok(mkt.entry < 588.02, "market short slips below the level");
  assert.equal(lim.entry, 588.02, "limit short fills exactly at the level — no phantom entry");
});

test("thesis: open, hit target → positive R; hit stop → −1R", () => {
  const setup = { symbol: "BTCUSDT", market: "crypto", side: "long", kind: "breakout", timeframe: "5m", entry: 100, stop: 98, target: 104, reason: "t" };
  const th = openThesis(setup, { equity: 10000, openRisk: 0, asset: "crypto", heatCap: 0.06, baseRiskPct: 0.02 });
  assert.equal(th.side, "long"); assert.ok(th.entry > 100 && th.entry < 101, "entry filled with slippage");
  const win = evaluateExit(th, bar(103, 105, 103, 104), { now: th.openedAt + 1000 });
  assert.equal(win.outcome, "target"); assert.ok(win.R > 1.5, "≈2R win after costs");
  const loss = evaluateExit(th, bar(99, 99.5, 97.5, 98), { now: th.openedAt + 1000 });
  assert.equal(loss.outcome, "stop"); assert.ok(loss.R < -0.9 && loss.R > -1.2, "≈−1R loss");
});

test("Bug 1/B: stop clears the noise floor, risk is all-in, and a clean stop-out realises ≈ -1.00R", () => {
  // An absurdly tight crypto stop (0.017%) like the BTCUSDT report — openThesis must
  // widen it to the noise floor; risk must be the ALL-IN risk (stop dist + exit slip).
  const setup = { symbol: "BTCUSDT", market: "crypto", side: "long", kind: "breakout", timeframe: "5m", entry: 63563.45, stop: 63552.65, target: 64000, reason: "t" };
  const th = openThesis(setup, { equity: 10000, openRisk: 0, asset: "crypto", heatCap: 0.10, baseRiskPct: 0.02 });
  assert.ok(th, "thesis opens on a widened stop");
  assert.ok(th.entry - th.stop >= th.entry * 0.004 - 1e-6, "stop widened to ≥ 0.4% noise floor");
  // riskAmt is the all-in risk: strictly MORE than the bare stop distance × size (the
  // difference is the exit spread/fee now folded into sizing — Bug B).
  assert.ok(th.riskAmt > th.size * (th.entry - th.stop), "risk includes exit slippage, not just |entry−stop|");
  // The real invariant: a bar that trades through the stop closes at ≈ -1.00R, not -1.15R.
  const stopOut = evaluateExit(th, { high: th.entry, low: th.stop - 1e-9, close: th.stop, open: th.entry }, { now: th.openedAt + 1000 });
  assert.equal(stopOut.outcome, "stop");
  assert.ok(Math.abs(stopOut.R + 1) < 0.02, `clean stop-out ≈ -1R (got ${stopOut.R.toFixed(3)})`);
  // Liquidation must sit BEYOND the stop (margin safeguard) for a long: stop first.
  assert.ok(th.liqPrice < th.stop, "liquidation is further from entry than the stop");
});

test("openThesis skips a setup whose reward:risk collapses once the stop is widened", () => {
  // Target only a hair above entry → widening the stop makes R:R < floor → no trade.
  const setup = { symbol: "ETHUSDT", market: "crypto", side: "long", kind: "breakout", timeframe: "5m", entry: 3000, stop: 2999.5, target: 3002, reason: "t" };
  const th = openThesis(setup, { equity: 10000, openRisk: 0, asset: "crypto", heatCap: 0.10, baseRiskPct: 0.02 });
  assert.equal(th, null, "poor R:R after min-stop → skipped");
});

test("ledger stats aggregate win rate + R-expectancy, sumR = avgR × n", () => {
  const s = ledgerStats([{ pnl: 200, R: 2 }, { pnl: -100, R: -1 }, { pnl: -100, R: -1 }, { pnl: 300, R: 3 }]);
  assert.equal(s.n, 4); assert.equal(s.wins, 2); assert.equal(s.winRate, 0.5);
  assert.ok(Math.abs(s.avgR - 0.75) < 1e-9, "avg R = (2-1-1+3)/4");
  assert.ok(Math.abs(s.sumR - 3) < 1e-9, "cumulative R = 3");
  assert.ok(Math.abs(s.sumR - s.avgR * s.n) < 1e-9, "header total = avg × n (Bug C: can't be misread)");
});

test("Bug C: a null-R close is recomputed from pnl/riskAmt, not counted as 0R", () => {
  // Legacy/liquidation close with no stored R → tradeR fills it from pnl/riskAmt so
  // it can't silently dilute the header average (0 in the sum but 1 in the count).
  const c = { pnl: -150, riskAmt: 100 }; // = -1.5R
  assert.ok(Math.abs(tradeR(c) + 1.5) < 1e-9, "tradeR recomputes -1.5R");
  const s = ledgerStats([{ pnl: -100, R: -1 }, c]);
  assert.ok(Math.abs(s.avgR + 1.25) < 1e-9, "avg = (-1 + -1.5)/2, null-R not diluted to 0");
});

test("breakout scanner triggers long above the range high, with stop<entry<target", () => {
  const candles = [...flat(40, 100), bar(100, 103.2, 100, 103)]; // close breaks the ~100.3 high
  const r = breakout(candles, { n: 20, atrPeriod: 14 });
  assert.ok(r && r.state === "triggered" && r.side === "long", "triggered long");
  assert.ok(r.stop < r.entry && r.entry < r.target, "coherent stop/entry/target");
});

test("mean-reversion fades a stretch far below VWAP", () => {
  const candles = [...flat(70, 100, 0.5), bar(100, 100, 96.5, 96.6)]; // ~7 ATR below VWAP
  const r = meanReversion(candles, { bars: 60, atrPeriod: 14, mult: 2.2 });
  assert.ok(r && r.side === "long" && r.kind === "mean-reversion", "long fade");
  assert.ok(r.target > r.entry && r.stop < r.entry, "target = mean, stop below");
});

test("breakout carries a retest level below the entry — the 'better entry' the agent may wait for", () => {
  const candles = [...flat(40, 100), bar(100, 103.2, 100, 103)];
  const r = breakout(candles, { n: 20, atrPeriod: 14 });
  assert.ok(Number.isFinite(r.retest) && r.retest < r.entry, "retest = broken high, below the chase entry");
});

test("reward:risk is situational, NOT a fixed 2:1 — a decisive breakout targets further", () => {
  const decisive = breakout([...flat(40, 100), bar(100, 103.2, 100, 103)], { n: 20, atrPeriod: 14 });  // broke ~2.7 ATR
  const marginal = breakout([...flat(40, 100), bar(100, 100.4, 100, 100.33)], { n: 20, atrPeriod: 14 }); // just cleared the high
  assert.ok(decisive.rMult > 2, `decisive break aims beyond 2:1 (got ${decisive.rMult})`);
  assert.ok(marginal.rMult >= 1.5 && marginal.rMult < decisive.rMult, `marginal break aims lower (got ${marginal.rMult})`);
  // The target actually reflects the chosen R:R.
  const rr = plannedRR(decisive.side, decisive.entry, decisive.stop, decisive.target);
  assert.ok(Math.abs(rr - decisive.rMult) < 1e-9, "target = entry ± rMult × risk");
});

test("scan gates trend setups by higher-timeframe bias", () => {
  // 1h uptrend, a fresh 5m breakout long → should pass the bias gate
  const up1h = Array.from({ length: 40 }, (_, i) => bar(100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i, 1000, i));
  const c5 = [...flat(40, 130), bar(130, 133, 130, 132.8)];
  const out = scan({ c5, c15: c5, c1h: up1h });
  assert.equal(out.bias, "up");
  assert.ok(out.triggered.some((t) => t.side === "long"), "long breakout allowed in uptrend");
});

// ── Phase-1 foundation: alt-data briefing ───────────────────────────────────
import { decodeEntities, diffBrief, chokepointCongestion, summarizeConflicts } from "../src/lib/argus/brief.js";

test("decodeEntities cleans RSS headline entities", () => {
  assert.equal(decodeEntities("Tesla&#x2019;s Q2 &amp; the &#8212; drop"), "Tesla’s Q2 & the — drop");
});

test("diffBrief surfaces new headlines, hazards, conflict escalation", () => {
  const prev = { headlines: [{ title: "old" }], disasters: [{ name: "H1" }], conflicts: [{ country: "X", deaths: 100 }], chokepoints: {} };
  const cur = { headlines: [{ title: "old" }, { title: "NEW", source: "S" }], disasters: [{ name: "H1" }, { alert: "red", type: "flood", country: "Y", name: "H2" }], conflicts: [{ country: "X", deaths: 150 }], chokepoints: {} };
  const d = diffBrief(prev, cur);
  assert.ok(d.some((x) => x.kind === "news" && x.text.includes("NEW")), "new headline");
  assert.ok(d.some((x) => x.kind === "hazard" && x.text.includes("H2")), "new hazard");
  assert.ok(d.some((x) => x.kind === "conflict" && x.text.includes("X")), "conflict escalation +50");
});

test("chokepointCongestion counts vessels + anchored in the Hormuz box", () => {
  const ships = [[1, 26.0, 56.5, 0.2], [2, 26.5, 57.0, 8], [3, 0, 0, 5]]; // 2 in Hormuz, 1 anchored
  const cp = chokepointCongestion(ships);
  assert.equal(cp.hormuz.ships, 2); assert.equal(cp.hormuz.anchored, 1);
});

// ── Phase-1: event-channel LLM thesis parsing ───────────────────────────────
import { parseTheses } from "../src/lib/argus/llm.js";

test("parseTheses extracts a fenced JSON array, uppercases + clamps", () => {
  const reply = 'Here you go:\n```json\n[{"symbol":"uso","side":"long","thesis":"Refinery fire tightens gasoline supply","invalidation":"crack spreads roll over","confidence":1.7,"horizon":"2d","evidence":["fire at Gulf Coast refinery"]}]\n```';
  const t = parseTheses(reply);
  assert.equal(t.length, 1);
  assert.equal(t[0].symbol, "USO", "symbol uppercased");
  assert.equal(t[0].side, "long");
  assert.equal(t[0].confidence, 1, "confidence clamped to [0,1]");
  assert.equal(t[0].evidence.length, 1);
});

test("parseTheses tolerates prose around a bare array and drops malformed items", () => {
  const reply = 'I think:\n[{"symbol":"NVDA","side":"long","thesis":"x"},{"side":"short"},{"symbol":"SPY","side":"sideways"}]\nThat is all.';
  const t = parseTheses(reply);
  assert.equal(t.length, 1, "only the one well-formed thesis survives");
  assert.equal(t[0].symbol, "NVDA");
});

test("parseTheses caps at 3 and returns [] on non-JSON / empty", () => {
  const many = "[" + Array.from({ length: 6 }, (_, i) => `{"symbol":"T${i}","side":"long","thesis":"y"}`).join(",") + "]";
  assert.equal(parseTheses(many).length, 3, "capped at 3");
  assert.deepEqual(parseTheses("no trades today, market is quiet"), []);
  assert.deepEqual(parseTheses(""), []);
});

// ── Phase-2: market hours (real day-trader) ─────────────────────────────────
import { marketOpen } from "../src/lib/argus/hours.js";

test("marketOpen: crypto 24/7; stocks only in RTH on weekdays", () => {
  const sat = new Date("2026-07-25T15:00:00Z"); // Saturday, 11:00 ET
  assert.equal(marketOpen({ asset: "crypto", symbol: "BTCUSDT" }, sat), true, "crypto open on weekend");
  assert.equal(marketOpen({ asset: "stock", symbol: "SPY" }, sat), false, "stocks closed on Saturday");
  const wedMid = new Date("2026-07-22T18:00:00Z"); // Wed 14:00 ET (DST) → open
  assert.equal(marketOpen({ asset: "stock", symbol: "SPY" }, wedMid), true, "stocks open midday weekday");
  const wedNight = new Date("2026-07-22T02:00:00Z"); // Tue 22:00 ET → closed
  assert.equal(marketOpen({ asset: "stock", symbol: "SPY" }, wedNight), false, "stocks closed overnight");
});

// ── Phase-2: Hermes learning ────────────────────────────────────────────────
import { deriveLessons, adjustment } from "../src/lib/argus/learn.js";

const closed = (n, kind, side, R) => Array.from({ length: n }, (_, i) =>
  ({ kind, side, symbol: "SOLUSDT", outcome: R > 0 ? "target" : "stop", R, pnl: R * 100, openedAt: Date.UTC(2026, 0, 1, 14) + i * 60000 }));

test("deriveLessons respects minSample and flags a losing bucket", () => {
  assert.equal(deriveLessons(closed(10, "mean-reversion", "short", -1), { minSample: 20 }).length, 0, "below minSample → no lessons");
  const lessons = deriveLessons(closed(30, "mean-reversion", "short", -0.6), { minSample: 20 });
  assert.ok(lessons.some((l) => l.action === "suppress" && l.dims.kind === "mean-reversion"), "losing bucket → suppress lesson");
});

test("adjustment clamps to [0.5,1.25] and only matching, well-sampled buckets act", () => {
  const lessons = deriveLessons(closed(40, "mean-reversion", "short", -1), { minSample: 20 });
  const a = adjustment(lessons, { kind: "mean-reversion", symbol: "SOLUSDT", side: "short" }, { minSample: 20 });
  assert.ok(a.mult >= 0.5 && a.mult < 1, "losing setup shrinks size, clamped ≥0.5");
  const b = adjustment(lessons, { kind: "breakout", symbol: "BTCUSDT", side: "long" }, { minSample: 20 });
  assert.equal(b.mult, 1, "non-matching setup unaffected");
});

// ── Phase-3: Hermes reflection loop ─────────────────────────────────────────
import { describeTrade, parseReflection, crystallise, skillsFor, unionSkills } from "../src/lib/argus/reflect.js";

const closedTrade = (over = {}) => ({
  id: "t1", symbol: "SOLUSDT", asset: "crypto", kind: "mean-reversion", side: "short",
  timeframe: "5m", reason: "Stretched 3.1 ATR above VWAP", entry: 74.18, stop: 74.30,
  target: 73.99, plannedR: 2, outcome: "stop", exit: 74.30, R: -1.05, pnl: -190, riskAmt: 181,
  openedAt: 1e12, exitAt: 1e12 + 36e5, ...over,
});

test("describeTrade states the facts a post-mortem needs", () => {
  const s = describeTrade(closedTrade({ catalyst: "OPEC cut" }));
  assert.match(s, /SOLUSDT/); assert.match(s, /mean-reversion short/);
  assert.match(s, /stop/); assert.match(s, /-1\.05R/); assert.match(s, /OPEC cut/);
});

test("parseReflection extracts a journal entry and clamps confidence", () => {
  const reply = '```json\n{"verdict":"bad-process","cause":"faded a strong uptrend","mistake":"ignored the 1h bias",' +
    '"lesson":"skip mean-reversion shorts while the 1h bias is up","applies":{"kind":"mean-reversion","side":"short"},"confidence":1.4}\n```';
  const e = parseReflection(reply, closedTrade());
  assert.equal(e.verdict, "bad-process");
  assert.equal(e.confidence, 1, "clamped to [0,1]");
  assert.equal(e.applies.kind, "mean-reversion");
  assert.equal(e.applies.symbol, null, "omitted dimension stays null");
  assert.equal(e.R, -1.05);
  assert.equal(parseReflection("no json here", closedTrade()), null);
});

test("post-mortem judges and records the leverage Argus chose (learning)", () => {
  const t = closedTrade({ leverage: 80 });
  const e = parseReflection('{"verdict":"bad-process","cause":"c","mistake":"m","lesson":"80x on a low-conviction fade left no room","leverage":"too-high","applies":{"kind":"mean-reversion"},"confidence":0.7}', t);
  assert.equal(e.leverage, "too-high", "captures the coach's leverage judgement");
  assert.equal(e.lev, 80, "records the leverage that was actually used");
  // Missing/invalid leverage field defaults to na.
  const e2 = parseReflection('{"verdict":"neutral","cause":"c","mistake":"none","lesson":"","confidence":0.3}', t);
  assert.equal(e2.leverage, "na");
  // describeTrade surfaces the leverage + liquidation buffer for the coach to judge.
  assert.match(describeTrade(t), /Leverage 80×/);
});

test("crystallise promotes a lesson only after it repeats, and skillsFor matches scope", () => {
  const one = parseReflection('{"verdict":"bad-process","cause":"c","mistake":"m","lesson":"skip mean-reversion shorts in an uptrend","applies":{"kind":"mean-reversion","side":"short"},"confidence":0.8}', closedTrade());
  assert.equal(crystallise([one, one]).length, 0, "twice is not yet a rule");
  const skills = crystallise([one, one, one]);
  assert.equal(skills.length, 1, "three times becomes a skill");
  assert.equal(skills[0].verdict, "avoid");
  assert.ok(skills[0].avgR < 0);
  assert.equal(skillsFor(skills, { kind: "mean-reversion", symbol: "SOLUSDT", side: "short" }).length, 1, "applies to the matching setup");
  assert.equal(skillsFor(skills, { kind: "breakout", symbol: "SOLUSDT", side: "long" }).length, 0, "not to a different setup");
});

test("unionSkills keeps retained knowledge across a reset that cleared the journal (Bug 2)", () => {
  const one = parseReflection('{"verdict":"bad-process","cause":"c","mistake":"m","lesson":"skip mean-reversion shorts in an uptrend","applies":{"kind":"mean-reversion","side":"short"},"confidence":0.8}', closedTrade());
  const retained = crystallise([one, one, one]); // a skill earned BEFORE the reset
  // After the reset the journal is empty → crystallise([]) is []; retained must survive.
  const merged = unionSkills(retained, crystallise([]));
  assert.equal(merged.length, 1, "retained skill kept even though the journal is empty");
  // A fresh, different lesson is added alongside the retained one (no dupes).
  const other = parseReflection('{"verdict":"good-process","cause":"c","mistake":"none","lesson":"take breakout longs with the 1h trend","applies":{"kind":"breakout","side":"long"},"confidence":0.8}', closedTrade());
  const merged2 = unionSkills(retained, crystallise([other, other, other]));
  assert.equal(merged2.length, 2, "retained + fresh, de-duped");
});

test("closeThesisAt force-closes at a reference price, tagged manual", () => {
  const setup = { symbol: "BTCUSDT", market: "crypto", side: "long", kind: "breakout", timeframe: "5m", entry: 100, stop: 98, target: 106, reason: "t" };
  const th = openThesis(setup, { equity: 10000, openRisk: 0, asset: "crypto", heatCap: 0.06, baseRiskPct: 0.02 });
  const res = closeThesisAt(th, 103); // dev closes mid-trade, before target
  assert.equal(res.outcome, "manual");
  assert.equal(res.state, "closed");
  assert.ok(res.exit < 103, "long exit fills below the mark (slippage)");
  assert.ok(res.pnl > 0 && res.R > 0, "closed in profit");
});

import { parseFearGreed, buildBrief, renderBrief } from "../src/lib/argus/brief.js";
test("parseFearGreed reads the alternative.me shape + renders into the brief", () => {
  const fng = parseFearGreed({ data: [{ value: "22", value_classification: "Extreme Fear", timestamp: "1" }] });
  assert.deepEqual(fng, { value: 22, classification: "Extreme Fear" });
  assert.equal(parseFearGreed({ data: [] }), null);
  const brief = buildBrief({ news: [], fng });
  assert.equal(brief.fearGreed.value, 22);
  assert.match(renderBrief(brief), /Fear & Greed index: 22\/100 \(Extreme Fear\)/);
});
