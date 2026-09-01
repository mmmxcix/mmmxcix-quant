import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSymbol, normalizeContracts, interpolateAt, atmIvAtIndex, ivAtDelta, putCallRatio, summarizeChain,
} from "../src/lib/binanceOptions.js";

// Chain-summary math for the Binance options source. A fixed synthetic chain
// with a KNOWN skew and known deltas, so every derived number has a hand-
// computable expected value — no network, no dependence on today's market.

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const DAY = 86400_000;
const close = (a, b, msg = "", eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}${msg ? " — " + msg : ""}`);

// Strikes 90..110; IV falls 2 vol points per 5 strikes (a put-rich skew), same
// surface for calls and puts as on Binance. Deltas: call 0.8→0.2, put = call − 1.
const STRIKES = [90, 95, 100, 105, 110];
const IV = { 90: 0.60, 95: 0.58, 100: 0.56, 105: 0.54, 110: 0.52 };
const CALL_DELTA = { 90: 0.8, 95: 0.65, 100: 0.5, 105: 0.35, 110: 0.2 };

function expiry(dteDays, { iv = (k) => IV[k], callVol = 20, putVol = 30, callOi = 10, putOi = 20, withOi = true } = {}) {
  const expiryMs = NOW + dteDays * DAY;
  const rows = [];
  for (const k of STRIKES) {
    for (const side of ["CALL", "PUT"]) {
      rows.push({
        symbol: `BTC-${dteDays}-${k}-${side[0]}`, underlying: "BTCUSDT", base: "BTC", yymmdd: String(dteDays),
        expiry: new Date(expiryMs).toISOString().slice(0, 10), expiryMs, dte: dteDays, strike: k, side,
        markIV: iv(k), delta: side === "CALL" ? CALL_DELTA[k] : CALL_DELTA[k] - 1,
        volume: side === "CALL" ? callVol : putVol,
        amountUsdt: 100,
        oi: withOi ? (side === "CALL" ? callOi : putOi) : null,
        oiUsd: withOi ? (side === "CALL" ? callOi : putOi) * k : null,
      });
    }
  }
  return rows;
}

test("parseSymbol reads base / expiry code / strike / side and rejects junk", () => {
  assert.deepEqual(parseSymbol("BTC-260925-83000-C"), { base: "BTC", yymmdd: "260925", strike: 83000, side: "CALL" });
  assert.deepEqual(parseSymbol("XAU-260904-3500-P"), { base: "XAU", yymmdd: "260904", strike: 3500, side: "PUT" });
  assert.equal(parseSymbol("BTCUSDT"), null);
});

test("interpolateAt is linear inside the points and clamps outside", () => {
  const pts = [{ x: 10, y: 0.55 }, { x: 60, y: 0.50 }];
  close(interpolateAt(pts, 30), 0.53);
  close(interpolateAt(pts, 0), 0.55);
  close(interpolateAt(pts, 100), 0.50);
  assert.equal(interpolateAt([], 30), null);
});

test("ATM IV interpolates the strike surface at the index price", () => {
  const rows = expiry(10);
  close(atmIvAtIndex(rows, 102.5), 0.55);   // halfway between 100 (0.56) and 105 (0.54)
  close(atmIvAtIndex(rows, 100), 0.56);
  close(atmIvAtIndex(rows, 500), 0.52);     // beyond the ladder: nearest, never extrapolated
  assert.equal(atmIvAtIndex(rows, null), null);
});

test("25-delta IVs come from the bracketing contracts on each side; skew = put − call", () => {
  const rows = expiry(10);
  const calls = rows.filter((r) => r.side === "CALL");
  const puts = rows.filter((r) => r.side === "PUT");
  // call 0.25Δ sits a third of the way from 110 (Δ.20, .52) to 105 (Δ.35, .54)
  close(ivAtDelta(calls, 0.25), 0.52 + 0.02 / 3);
  // put −0.25Δ sits two thirds of the way from 95 (Δ−.35, .58) to 90 (Δ−.20, .60)
  close(ivAtDelta(puts, -0.25), 0.58 + 0.02 * 2 / 3);
  // no clamping: a chain that never reaches the delta has no 25Δ read
  assert.equal(ivAtDelta(calls.filter((r) => r.delta < 0.6), 0.7), null);
  assert.equal(ivAtDelta([calls[0]], 0.8), null);
});

test("put/call ratio by volume and by OI", () => {
  const rows = expiry(10);
  close(putCallRatio(rows, "volume"), 1.5);
  close(putCallRatio(rows, "oi"), 2);
  assert.equal(putCallRatio(rows.filter((r) => r.side === "PUT"), "volume"), null, "no calls → no ratio");
});

test("summarizeChain: term structure, 30-day interpolation, ratios, OI and the illiquid tag", () => {
  const near = expiry(10);
  const far = expiry(60, { iv: () => 0.50, withOi: false }); // flat surface, outside the OI window
  const s = summarizeChain([...far, ...near], 102.5);

  assert.equal(s.expiries.length, 2);
  assert.deepEqual(s.expiries.map((e) => e.dte), [10, 60], "expiries ascend by date");
  close(s.expiries[0].atmIv, 0.55);
  close(s.expiries[0].skew25, (0.58 + 0.02 * 2 / 3) - (0.52 + 0.02 / 3));
  close(s.expiries[1].atmIv, 0.50);
  close(s.expiries[1].skew25, 0, "a flat surface has no skew");

  close(s.atmIv30, 0.53, "30d ATM IV interpolated between the 10d and 60d expiries");
  close(s.pcrVolume, 1.5);
  close(s.pcrOi, 2, "OI ratio only over the expiries that have OI");
  assert.equal(s.oiExpiries, 1);
  close(s.oi, 150);
  close(s.oiUsd, STRIKES.reduce((a, k) => a + 30 * k, 0));
  assert.equal(s.expiries[1].pcrOi, null, "no OI fetched → null, not zero");

  close(s.turnover24h, 2000);
  assert.equal(s.illiquid, true, "2,000 USDT a day is illiquid by the default threshold");
  assert.equal(summarizeChain(near, 102.5, { illiquidBelow: 500 }).illiquid, false);
});

test("summarizeChain ignores expired contracts and survives an empty chain", () => {
  const dead = expiry(10).map((r) => ({ ...r, dte: -1 }));
  const s = summarizeChain(dead, 100);
  assert.equal(s.expiries.length, 0);
  assert.equal(s.atmIv30, null);
  assert.equal(s.pcrVolume, null);
  assert.equal(summarizeChain([], 100).contractCount, 0);
});

test("normalizeContracts merges the three feeds and maps Binance's sentinels", () => {
  const info = { optionSymbols: [
    { symbol: "BTC-260925-83000-C", underlying: "BTCUSDT", baseAsset: "BTC", strikePrice: "83000.000", side: "CALL", expiryDate: NOW + 24 * DAY, status: "TRADING" },
    { symbol: "BTC-260925-83000-P", underlying: "BTCUSDT", baseAsset: "BTC", strikePrice: "83000.000", side: "PUT", expiryDate: NOW + 24 * DAY, status: "TRADING" },
    { symbol: "BTC-200101-1000-C", underlying: "BTCUSDT", baseAsset: "BTC", strikePrice: "1000", side: "CALL", expiryDate: NOW - DAY, status: "TRADING" },
  ] };
  const marks = [{ symbol: "BTC-260925-83000-C", markPrice: "1225", markIV: "0.45", bidIV: "-1.0", askIV: "0.47", delta: "0.41", theta: "-30", gamma: "0.00001", vega: "60" }];
  const tickers = [{ symbol: "BTC-260925-83000-C", lastPrice: "1225", bidPrice: "1145", askPrice: "1150", volume: "16.87", amount: "21853.7", tradeCount: 28 }];
  const out = normalizeContracts(info, marks, tickers, NOW);
  assert.equal(out.length, 2, "the expired contract is dropped");
  const c = out.find((x) => x.side === "CALL");
  assert.equal(c.expiry, "2026-09-25");
  close(c.dte, 24);
  assert.equal(c.strike, 83000);
  assert.equal(c.markIV, 0.45);
  assert.equal(c.bidIV, null, "bidIV -1.0 means no bid");
  assert.equal(c.bid, 1145);
  assert.equal(c.amountUsdt, 21853.7);
  assert.equal(c.oi, null);
  const p = out.find((x) => x.side === "PUT");
  assert.equal(p.markIV, null, "a contract the mark feed lacks has no IV, not a zero");
  assert.equal(p.volume, 0);
});
