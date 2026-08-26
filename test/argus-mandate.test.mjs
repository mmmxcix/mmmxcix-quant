// The Aug-26 mandate redo: WHEN Argus may trade, on WHICH timeframe it signals,
// and how big it is allowed to bet. Each test below pins one of the three
// findings that motivated the change, so a regression names itself.
import test from "node:test";
import assert from "node:assert/strict";

import {
  canOpen, paceStatus, openedInSession, parseSessionBudget,
  DEFAULT_SESSION_BUDGET, DEFAULT_MAX_PER_DAY,
} from "../src/lib/argus/pace.js";
import { aggregateCandles, riskLadder } from "../src/lib/argus/core.js";
import { scan } from "../src/lib/argus/scanners.js";
import { sessionOf } from "../src/lib/argus/learn.js";

const bar = (o, h, l, c, v = 1000, t = 0) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });
const flat = (n, mid, wick = 0.3, t0 = 0, step = 300) =>
  Array.from({ length: n }, (_, i) => bar(mid, mid + wick, mid - wick, mid, 1000, t0 + i * step));

// A UTC timestamp on a fixed day at a given hour, so session tests never depend
// on when they are run.
const DAY = "2026-08-26";
const at = (hour, min = 0) => Date.parse(`${DAY}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00Z`);

// ── 1. The session budget ────────────────────────────────────────────────────

test("the live failure: a full overnight book no longer blocks London", () => {
  // Exactly what the ledger showed — twelve trades, every one of them between
  // 00:00 and 06:00 UTC. Under the old flat cap that spent the WHOLE day.
  const overnight = Array.from({ length: 12 }, (_, i) => ({ openedAt: at(0, i * 20) }));
  assert.equal(sessionOf(overnight[0].openedAt), "asia");

  // Old behaviour, for the record: 12 opened today >= cap, so blocked at 09:00.
  assert.equal(canOpen(0, 12, { maxPerDay: DEFAULT_MAX_PER_DAY }).ok, false);

  // New behaviour: at 09:00 UTC the clock is in London, whose own budget is
  // untouched, so the overnight run cannot consume it.
  const london = at(9);
  assert.equal(sessionOf(london), "london");
  const room = canOpen(0, 12, {
    maxPerDay: DEFAULT_MAX_PER_DAY,
    session: sessionOf(london),
    sessionOpened: openedInSession(overnight, [], london),
  });
  assert.equal(room.ok, true, "London has its own slots");
});

test("a session refuses once ITS budget is spent, naming the session", () => {
  const asiaFull = Array.from({ length: DEFAULT_SESSION_BUDGET.asia }, (_, i) => ({ openedAt: at(1, i * 5) }));
  const now = at(2);
  const r = canOpen(0, asiaFull.length, {
    session: sessionOf(now), sessionOpened: openedInSession(asiaFull, [], now),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /asia session/, "the refusal names the local cap, not the daily total");
});

test("the session count is scoped to today AND to this session", () => {
  const yesterdayAsia = [{ openedAt: Date.parse("2026-08-25T01:00:00Z") }];
  const todayNy = [{ openedAt: at(14) }];
  const now = at(2); // asia, today
  assert.equal(openedInSession([...yesterdayAsia, ...todayNy], [], now), 0,
    "neither yesterday's Asia nor today's New York spends today's Asia");
});

test("unused session slots do not roll over into the next session", () => {
  // Nothing traded in Asia; London still gets exactly its own budget, not more.
  const st = paceStatus([], [], {}, at(9));
  assert.equal(st.session, "london");
  assert.equal(st.sessionCap, DEFAULT_SESSION_BUDGET.london);
  assert.equal(st.sessionLeft, DEFAULT_SESSION_BUDGET.london);
});

test("the session caps bound the day by construction", () => {
  // A full day spread across the sessions reaches exactly the daily budget, and
  // every session correctly refuses its own next trade.
  const spread = [
    ...Array.from({ length: DEFAULT_SESSION_BUDGET.asia }, (_, i) => ({ openedAt: at(1, i) })),
    ...Array.from({ length: DEFAULT_SESSION_BUDGET.london }, (_, i) => ({ openedAt: at(8, i) })),
    ...Array.from({ length: DEFAULT_SESSION_BUDGET.ny }, (_, i) => ({ openedAt: at(13, i) })),
    ...Array.from({ length: DEFAULT_SESSION_BUDGET.off }, (_, i) => ({ openedAt: at(21, i) })),
  ];
  assert.equal(spread.length, DEFAULT_MAX_PER_DAY, "the split redistributes the day, it does not enlarge it");
  for (const hour of [2, 9, 14, 22]) {
    const now = at(hour);
    const r = canOpen(0, spread.length, {
      session: sessionOf(now), sessionOpened: openedInSession(spread, [], now),
    });
    assert.equal(r.ok, false, `${sessionOf(now)} is full`);
  }
});

test("callers that pass no session keep the old flat daily cap", () => {
  // pace.js is imported by consumers that do not track the clock; dropping the
  // daily check for THEM would be an uncapping, not a fix.
  assert.equal(canOpen(0, DEFAULT_MAX_PER_DAY, { maxPerDay: DEFAULT_MAX_PER_DAY }).ok, false);
  assert.equal(canOpen(0, DEFAULT_MAX_PER_DAY - 1, { maxPerDay: DEFAULT_MAX_PER_DAY }).ok, true);
});

test("a mistyped session budget is clamped, never uncapped", () => {
  assert.equal(parseSessionBudget("asia:9999").asia, DEFAULT_MAX_PER_DAY);
});

test("parseSessionBudget overrides what it understands and ignores nonsense", () => {
  assert.deepEqual(parseSessionBudget("ny:6,london:5"), { ...DEFAULT_SESSION_BUDGET, ny: 6, london: 5 });
  // A mistyped env var must not silently uncap a 24/7 agent.
  assert.deepEqual(parseSessionBudget("garbage"), { ...DEFAULT_SESSION_BUDGET });
  assert.deepEqual(parseSessionBudget(""), { ...DEFAULT_SESSION_BUDGET });
  assert.deepEqual(parseSessionBudget("ny:-3"), { ...DEFAULT_SESSION_BUDGET });
});

// ── 2. The signal timeframe ──────────────────────────────────────────────────

test("aggregateCandles buckets on wall-clock boundaries, not array position", () => {
  // Start MID-bucket (t=600 into a 900s bar). Chunk-by-3 would produce bars that
  // move whenever the provider returns a different first candle; wall-clock
  // bucketing gives the bars a chart would draw.
  const c = Array.from({ length: 10 }, (_, i) => bar(10, 12, 9, 11, 1, 900 * 4 + 600 + i * 300));
  const out = aggregateCandles(c, 900);
  for (const b of out) assert.equal(b.time % 900, 0, "every bar opens on a 15m boundary");
});

test("aggregateCandles drops a still-forming trailing bar", () => {
  const complete = Array.from({ length: 12 }, (_, i) => bar(10, 12, 9, 11, 1, i * 300));
  assert.equal(aggregateCandles(complete, 900).length, 4);
  // One extra 5m candle opens a 5th bucket that has only 1 of its 3 candles.
  assert.equal(aggregateCandles([...complete, bar(10, 12, 9, 11, 1, 12 * 300)], 900).length, 4,
    "a half-formed bar is not a level anything may trade off");
});

test("aggregateCandles carries OHLCV correctly", () => {
  const c = [bar(10, 15, 8, 12, 5, 0), bar(12, 20, 11, 13, 7, 300), bar(13, 14, 2, 9, 3, 600)];
  const [b] = aggregateCandles(c, 900);
  assert.deepEqual([b.open, b.high, b.low, b.close, b.volume], [10, 20, 2, 9, 15]);
});

test("scan signals on 15m when asked, and stamps the bar it used", () => {
  const up1h = Array.from({ length: 40 }, (_, i) => bar(100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i, 1000, i));
  // The breakout must fill a WHOLE 15m bucket — a lone 5m candle opens a bucket
  // the aggregator correctly withholds as still forming.
  const c5 = [
    ...flat(120, 130),
    bar(130, 133, 130, 132.8, 1000, 120 * 300),
    bar(132.8, 133.2, 132.5, 133.0, 1000, 121 * 300),
    bar(133.0, 133.4, 132.8, 133.2, 1000, 122 * 300),
  ];
  const c15 = aggregateCandles(c5, 900);
  assert.ok(c15.length >= 40, "fixture actually has enough 15m bars");
  const out = scan({ c5, c15, c1h: up1h }, { timeframe: "15m" });
  assert.ok(out.triggered.length > 0, "the fixture produces a setup to inspect");
  for (const t of out.triggered) {
    assert.equal(t.timeframe, "15m");
    assert.equal(t.barMs, 900_000);
    assert.equal(t.signalBarMs, (c15[c15.length - 1].time + 900) * 1000,
      "the stamp is when the signal bar CLOSED, which is what the staleness gate measures");
  }
});

test("scan falls back to 5m rather than going blind on a short 15m series", () => {
  const up1h = Array.from({ length: 40 }, (_, i) => bar(100 + i, 100 + i + 0.5, 100 + i - 0.5, 100 + i, 1000, i));
  const c5 = [...flat(40, 130), bar(130, 133, 130, 132.8, 1000, 40 * 300)];
  const out = scan({ c5, c15: aggregateCandles(c5, 900), c1h: up1h }, { timeframe: "15m" });
  // 41 five-minute bars is only ~13 fifteen-minute bars, below the 40-bar floor.
  assert.ok(out.triggered.length > 0, "it still scans");
  for (const t of out.triggered) {
    assert.equal(t.timeframe, "5m", "stamped with what it ACTUALLY read, never a fiction");
    assert.equal(t.barMs, 300_000);
  }
});

// ── 3. Size follows evidence ─────────────────────────────────────────────────

const book = (n, r) => Array.from({ length: n }, () => ({ pnl: r > 0 ? 1 : -1, R: r }));
const mixed = (n, winEvery, win, loss) =>
  Array.from({ length: n }, (_, i) => (i % winEvery === 0 ? { pnl: 1, R: win } : { pnl: -1, R: loss }));

test("an unproven book never sizes up, however good it looks", () => {
  const l = riskLadder(book(30, 2.0)); // spectacular, and far too few trades
  assert.equal(l.mult, 1);
  assert.match(l.reason, /unproven/);
});

test("a losing book never sizes up", () => {
  const l = riskLadder(mixed(200, 4, 1.5, -1.0)); // 25% wins at 1.5R, so negative
  assert.ok(l.avgR < 0);
  assert.equal(l.mult, 1);
  assert.match(l.reason, /not positive/);
});

test("a proven book steps up, and the rung is gated by sample before t", () => {
  const good = mixed(60, 2, 2.0, -1.0); // ~+0.5R expectancy, strongly significant
  const l = riskLadder(good);
  assert.ok(l.tStat > 2, "clearly significant");
  assert.equal(l.rung, 1, "n=60 cannot reach rung 2 (n>=80) no matter how strong t is");
  assert.equal(l.mult, 1.5);
});

test("the ladder is a ratchet with no memory, so it drops back immediately", () => {
  const good = mixed(100, 2, 2.0, -1.0);
  assert.ok(riskLadder(good).mult > 1);
  // The same book plus a losing streak that flips expectancy negative.
  const spoiled = [...good, ...book(140, -1.0)];
  assert.equal(riskLadder(spoiled).mult, 1, "no accumulated rung survives a negative book");
});
