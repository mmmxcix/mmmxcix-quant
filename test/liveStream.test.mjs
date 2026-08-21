import { test } from "node:test";
import assert from "node:assert/strict";

// liveStream.js reads the WebSocket / rAF globals at module scope, so both are
// stubbed before it is imported. rAF is driven by hand so the coalescing is
// observable instead of timing-dependent.
let socket = null;
globalThis.WebSocket = class {
  constructor(url) { this.url = url; socket = this; }
  close() { this.closed = true; }
};
const frames = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
globalThis.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
const paint = () => { const due = frames.splice(0); due.forEach((f) => f && f()); };

const { openBinanceKlineStream } = await import("../src/lib/liveStream.js");

const send = (obj) => socket.onmessage({ data: JSON.stringify(obj) });
const trade = (p) => ({ stream: "ethusdt@aggTrade", data: { e: "aggTrade", p: String(p) } });
const book = (b, a) => ({ stream: "ethusdt@bookTicker", data: { u: 1, s: "ETHUSDT", b: String(b), a: String(a) } });

test("a live price subscribes to the trade tape AND the book", () => {
  const close = openBinanceKlineStream({ symbol: "ETHUSDT", interval: "15m", onCandle() {}, onTick() {} });
  assert.match(socket.url, /ethusdt@kline_15m/);
  assert.match(socket.url, /ethusdt@aggTrade/);
  assert.match(socket.url, /ethusdt@bookTicker/, "the book keeps the price moving when the tape is quiet");
  close();
});

test("a chart with no price display stays on the single kline stream", () => {
  const close = openBinanceKlineStream({ symbol: "ETHUSDT", interval: "1h", onCandle() {} });
  assert.match(socket.url, /\/ws\/ethusdt@kline_1h$/);
  close();
});

test("bursts of ticks coalesce to the NEWEST price, never the oldest", () => {
  // The old 120ms leading-edge throttle emitted the first print in a window and
  // dropped the rest — so the number on screen was routinely the stale one.
  const seen = [];
  const close = openBinanceKlineStream({
    symbol: "ETHUSDT", interval: "15m", onCandle() {}, onTick: (p) => seen.push(p),
  });
  send(trade(2507.11));
  send(trade(2507.19));
  send(trade(2507.42));
  assert.deepEqual(seen, [], "nothing paints before the frame");
  paint();
  assert.deepEqual(seen, [2507.42], "one paint per frame, carrying the latest print");
  close();
});

test("no frame is scheduled when nothing arrived, and each frame paints once", () => {
  const seen = [];
  const close = openBinanceKlineStream({
    symbol: "ETHUSDT", interval: "15m", onCandle() {}, onTick: (p) => seen.push(p),
  });
  send(trade(10));
  paint();
  paint();
  assert.deepEqual(seen, [10]);
  send(trade(11));
  paint();
  assert.deepEqual(seen, [10, 11]);
  close();
});

test("book updates arrive as bid/ask — they carry no event-type field", () => {
  const quotes = [];
  const close = openBinanceKlineStream({
    symbol: "ETHUSDT", interval: "15m", onCandle() {}, onQuote: (q) => quotes.push(q),
  });
  send(book(2507.05, 2507.15));
  paint();
  assert.deepEqual(quotes, [{ bid: 2507.05, ask: 2507.15 }]);
  close();
});

test("klines still flow through untouched", () => {
  const bars = [];
  const close = openBinanceKlineStream({
    symbol: "ETHUSDT", interval: "15m", onCandle: (c) => bars.push(c), onTick() {},
  });
  send({ stream: "ethusdt@kline_15m", data: { e: "kline", k: { t: 1755000000000, o: "1", h: "2", l: "0.5", c: "1.5", v: "9", x: true } } });
  assert.deepEqual(bars, [{ time: 1755000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9, closed: true }]);
  close();
});

test("closing the stream drops a frame that is still pending", () => {
  const seen = [];
  const close = openBinanceKlineStream({
    symbol: "ETHUSDT", interval: "15m", onCandle() {}, onTick: (p) => seen.push(p),
  });
  send(trade(99));
  close();
  paint();
  assert.deepEqual(seen, [], "a torn-down chart must not be painted into");
});
