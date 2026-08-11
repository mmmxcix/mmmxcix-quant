import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openPosition, markPosition, closePosition, bracketExit, equityCurve,
  verdict, judgeArena, ARENA_RULES, TAKER_FEE,
} from "../src/lib/arena.js";

// The arena replaces backtesting for order-book strategies, so its bookkeeping
// is the ONLY thing standing between "this works" and "this looked like it
// worked". These tests pin the parts that would flatter a strategy if wrong:
// fees, fill sides, and the rule that decides when to pull one.

const book = (bid, ask) => ({ bid, ask });

test("a position costs both legs in fees from the moment it opens", () => {
  const p = openPosition({ strategy: "mp", symbol: "BTCUSDT", side: "long", price: 100, stake: 1000, stop: 99 });
  assert.ok(p);
  assert.equal(p.riskAmt, 1000 * 0.01, "risk is the distance to the stop, not the stake");
  // Closing at the entry price is a LOSS — the round trip is not free. A model
  // that returns 0 here makes every scalping strategy look break-even.
  const flat = markPosition(p, 100);
  assert.ok(flat.pnl < 0, `flat exit must lose the fees, got ${flat.pnl}`);
  assert.equal(flat.pnl, -2 * 1000 * TAKER_FEE);
});

test("shorts make money when the price falls, and lose when it rises", () => {
  const s = openPosition({ strategy: "mp", symbol: "ETHUSDT", side: "short", price: 100, stake: 1000, stop: 101 });
  assert.ok(markPosition(s, 95).pnl > 0);
  assert.ok(markPosition(s, 105).pnl < 0);
  // …and the R-multiple is symmetric with the long case.
  const l = openPosition({ strategy: "mp", symbol: "ETHUSDT", side: "long", price: 100, stake: 1000, stop: 99 });
  assert.ok(Math.abs(markPosition(s, 95).R - markPosition(l, 105).R) < 1e-9);
});

test("refuses positions it cannot size honestly", () => {
  const bad = { strategy: "mp", symbol: "BTCUSDT", side: "long", price: 100, stake: 1000 };
  assert.equal(openPosition({ ...bad, stop: 100 }), null, "a stop at the entry is not a stop");
  assert.equal(openPosition({ ...bad, stop: 0 }), null);
  assert.equal(openPosition({ ...bad, stop: 99, price: 0 }), null);
  assert.equal(openPosition({ ...bad, stop: 99, side: "sideways" }), null);
});

test("brackets fill on the side of the book that would actually trade", () => {
  // A long exits by SELLING into the bid. Checking the ask instead is the
  // free-spread bug: every exit would look a tick better than it was.
  const long = openPosition({ strategy: "mp", symbol: "BTCUSDT", side: "long", price: 100, stake: 1000, stop: 99, target: 102 });
  assert.equal(bracketExit(long, book(98.9, 99.1))?.reason, "stop", "bid through the stop must fill");
  assert.equal(bracketExit(long, book(99.05, 99.2)), null, "ask below the stop is not enough");
  assert.equal(bracketExit(long, book(102.1, 102.3))?.reason, "target");

  const short = openPosition({ strategy: "mp", symbol: "BTCUSDT", side: "short", price: 100, stake: 1000, stop: 101, target: 98 });
  assert.equal(bracketExit(short, book(100.9, 101.1))?.reason, "stop", "ask through the stop must fill");
  assert.equal(bracketExit(short, book(97.8, 97.9))?.reason, "target");
});

test("a gapped stop fills at the gap, never at the stop level", () => {
  // The bracket-fill bug this codebase has already been bitten by once: if the
  // book is far through the stop, the fill is the book, not the wish.
  const long = openPosition({ strategy: "mp", symbol: "BTCUSDT", side: "long", price: 100, stake: 1000, stop: 99 });
  const x = bracketExit(long, book(95, 95.1));
  assert.equal(x.price, 95, "must fill at the bid, not at 99");
  assert.ok(closePosition(long, x.price, x.reason).R < -1, "…which is worse than a full R");
});

// A ledger of closed trades with a given mean and spread of R.
const ledger = (rs, t0 = 1_700_000_000_000) => rs.map((R, i) => ({
  state: "closed", R, pnl: R * 10, riskAmt: 10,
  openedAt: t0 + i * 3600e3, closedAt: t0 + i * 3600e3 + 60e3,
}));

test("no verdict before there is evidence — 'learning' is not 'passing'", () => {
  const e = { startedAt: Date.now(), ledger: ledger(new Array(10).fill(-1), Date.now()) };
  const v = verdict(e, { now: Date.now() });
  assert.equal(v.status, "learning", "10 straight losers is still too few to judge");
  assert.match(v.reason, /10\/30/);
});

test("a strategy that loses with confidence is evicted", () => {
  // 40 trades averaging −0.4R with realistic spread: t is comfortably past −2.
  const rs = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 1.2 : -0.93));
  const now = 1_700_000_000_000 + 41 * 3600e3;
  const v = verdict({ startedAt: 1_700_000_000_000, ledger: ledger(rs) }, { now });
  assert.equal(v.status, "evicted");
  assert.match(v.reason, /t=-/);
  assert.ok(v.stats.tStat <= ARENA_RULES.evictTStat);
});

test("a profitable strategy is left alone", () => {
  const rs = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? -1 : 0.9));
  const now = 1_700_000_000_000 + 41 * 3600e3;
  const v = verdict({ startedAt: 1_700_000_000_000, ledger: ledger(rs) }, { now });
  assert.equal(v.status, "active");
});

test("ruin does not wait for a sample size", () => {
  // Only 12 trades — below minTrades — but the stake is already gone. The
  // drawdown rule has to fire before the statistical one gets its chance.
  const rs = new Array(12).fill(-1);
  const pnl = rs.map((R) => ({
    state: "closed", R, pnl: -40, riskAmt: 40,
    openedAt: 1_700_000_000_000, closedAt: 1_700_000_000_000 + 60e3,
  }));
  const v = verdict({ startedAt: 1_700_000_000_000, ledger: pnl },
    { now: 1_700_000_000_000 + 3600e3, startEquity: 1000 });
  assert.equal(v.status, "evicted");
  assert.match(v.reason, /drawdown/);
});

test("a silent strategy is evicted too — an empty slot that looks like a result", () => {
  const t0 = 1_700_000_000_000;
  const v = verdict({ startedAt: t0, ledger: ledger([0.5, -0.5], t0) },
    { now: t0 + 40 * 864e5 });
  assert.equal(v.status, "evicted");
  assert.match(v.reason, /no trade in/);
});

test("equityCurve tracks the peak-to-trough drawdown, not the final loss", () => {
  // Up 300, down 400, back up 200: ends +100 but drew down 400 from the peak.
  const l = [{ pnl: 300, closedAt: 1 }, { pnl: -400, closedAt: 2 }, { pnl: 200, closedAt: 3 }];
  const { equity, maxDrawdownPct } = equityCurve(l, 1000);
  assert.equal(equity, 1100);
  assert.ok(Math.abs(maxDrawdownPct - 400 / 1300 * 100) < 1e-9,
    `drawdown is measured from the 1300 peak, got ${maxDrawdownPct}`);
});

test("eviction is final — a removed strategy is not re-judged back in", () => {
  const t0 = 1_700_000_000_000;
  const entries = [{ id: "a", status: "evicted", ledger: ledger([2, 2, 2], t0), evictReason: "was bad" }];
  const out = judgeArena(entries, { now: t0 + 3600e3 });
  assert.equal(out[0].status, "evicted", "a fresh winning streak must not resurrect it");
  assert.equal(out[0].evictReason, "was bad");
});
