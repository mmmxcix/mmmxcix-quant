import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setLiveQuote, resetLiveQuote, getLiveQuote, subscribeLiveQuote, livePriceOf, LIVE_PRICE_SOURCE,
} from "../src/lib/liveQuote.js";

// The chart price used to refresh ~3x/s with gaps over a second while the
// Binance tape was printing ~50 price changes a second. Two things caused it:
// the tick lived in page state (so every tick re-rendered the whole chart
// tree), and a 120ms leading-edge throttle threw away the newest print inside
// each window. These tests pin the invariants of the replacement so neither
// can come back unnoticed.

test("a trade tick notifies subscribers", () => {
  resetLiveQuote();
  let hits = 0;
  const off = subscribeLiveQuote(() => { hits += 1; });
  setLiveQuote({ last: 2507.11 });
  assert.equal(hits, 1);
  assert.equal(livePriceOf(getLiveQuote()), 2507.11);
  off();
});

test("a repeated price does not wake the header", () => {
  resetLiveQuote();
  setLiveQuote({ last: 2507.11 });
  let hits = 0;
  const off = subscribeLiveQuote(() => { hits += 1; });
  setLiveQuote({ last: 2507.11 });
  setLiveQuote({ last: 2507.11 });
  assert.equal(hits, 0, "same price must not cost a render");
  off();
});

test("book updates are stored but do not re-render while the tape drives the price", () => {
  resetLiveQuote();
  setLiveQuote({ last: 2507.11 });
  let hits = 0;
  const off = subscribeLiveQuote(() => { hits += 1; });
  // Binance pushes several times more book updates than trades; waking the
  // header for a number it does not display would undo the whole fix.
  setLiveQuote({ bid: 2507.05, ask: 2507.15 });
  setLiveQuote({ bid: 2507.06, ask: 2507.16 });
  assert.equal(hits, LIVE_PRICE_SOURCE === "mid" ? 2 : 0);
  const q = getLiveQuote();
  assert.equal(q.bid, 2507.06);
  assert.equal(q.mid, (2507.06 + 2507.16) / 2);
  off();
});

test("the mid carries the price until the first trade prints", () => {
  resetLiveQuote();
  setLiveQuote({ bid: 100, ask: 102 });
  assert.equal(livePriceOf(getLiveQuote()), 101, "a quiet tape still shows a price");
  setLiveQuote({ last: 100.5 });
  assert.equal(
    livePriceOf(getLiveQuote()),
    LIVE_PRICE_SOURCE === "mid" ? 101 : 100.5,
    "once trades print, the configured source wins",
  );
});

test("reset clears the quote so a stock symbol cannot show a stale crypto price", () => {
  resetLiveQuote();
  setLiveQuote({ last: 2507.11, bid: 2507.05, ask: 2507.15 });
  let hits = 0;
  const off = subscribeLiveQuote(() => { hits += 1; });
  resetLiveQuote();
  assert.equal(hits, 1);
  assert.equal(livePriceOf(getLiveQuote()), null);
  off();
});

test("unsubscribing stops the callbacks", () => {
  resetLiveQuote();
  let hits = 0;
  const off = subscribeLiveQuote(() => { hits += 1; });
  off();
  setLiveQuote({ last: 1 });
  assert.equal(hits, 0);
});
