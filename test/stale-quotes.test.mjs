import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHoldings, ageLabel } from "../src/lib/portfolioTotals.js";
import { buildEquityCurve } from "../src/lib/equityCurve.js";
import { applyFilters, unevaluable, scanCrypto } from "../src/lib/screener.js";
import { fetchQuotes, staleOrMissing } from "../src/lib/quotes.js";

// A failed source must never turn into a confident wrong number. Each test
// below pins one place where it used to: they fail against the old logic.

const isClosed = (p) => p.sellPrice > 0;
const AAPL = { market: "stock", symbol: "AAPL", shares: 10, avgPrice: 100 };
const MSFT = { market: "stock", symbol: "MSFT", shares: 5, avgPrice: 200 };

test("portfolio: a failed quote is excluded from P/L instead of counted as $0", () => {
  const quotes = {
    "stock:AAPL": { price: 110, changePct: 1, stale: false, asOf: 1 },
    // MSFT never quoted: the old code summed value ?? 0 but kept its $1,000 cost.
  };
  const { totals, rows } = computeHoldings([AAPL, MSFT], quotes, isClosed);
  assert.equal(totals.totalValue, 1100);
  assert.equal(totals.totalCost, 1000, "cost of the unpriced position must not count");
  assert.equal(totals.totalPnl, 100, "old code reported 1100 - 2000 = -900, a fake loss");
  assert.equal(totals.excludedCount, 1);
  assert.deepEqual(totals.excludedSymbols, ["MSFT"]);
  const msft = rows.find((r) => r.symbol === "MSFT");
  assert.equal(msft.stale, true);
  assert.equal(msft.allocPct, null);
});

test("portfolio: a stale quote keeps its last price and age but leaves the totals", () => {
  const asOf = Date.now() - 5 * 60_000;
  const quotes = {
    "stock:AAPL": { price: 110, changePct: 1, stale: false, asOf: Date.now() },
    "stock:MSFT": { price: 250, changePct: 2, stale: true, asOf },
  };
  const { totals, rows } = computeHoldings([AAPL, MSFT], quotes, isClosed);
  const msft = rows.find((r) => r.symbol === "MSFT");
  assert.equal(msft.price, 250, "the last known price is still shown");
  assert.equal(msft.asOf, asOf);
  assert.equal(ageLabel(msft.asOf), "5 min ago");
  assert.equal(totals.totalPnl, 100, "the stale position's P/L is not mixed into current totals");
  assert.equal(totals.excludedStaleValue, 1250);
  assert.equal(totals.dayPnl, 10 * (110 - 110 / 1.01));
});

test("portfolio: closed positions are unaffected (realized, no quote needed)", () => {
  const sold = { ...MSFT, sellPrice: 300 };
  const { totals } = computeHoldings([sold], {}, isClosed);
  assert.equal(totals.realizedPnl, 500);
  assert.equal(totals.excludedCount, 0);
});

const candles = (closes) => closes.map((close, i) => ({ time: 86400 * (i + 1), open: close, high: close, low: close, close, volume: 0 }));

test("equity curve: watchlist index starts at 100 when one symbol fails", () => {
  const specs = [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }];
  const settled = [
    { status: "fulfilled", value: candles([10, 11, 12]) },
    { status: "rejected", reason: new Error("429") },
    { status: "fulfilled", value: candles([50, 50, 55]) },
  ];
  const { data, loaded, failed } = buildEquityCurve("watchlist", specs, settled);
  assert.equal(loaded, 2);
  assert.deepEqual(failed, ["B"]);
  // Old weighting was 100 / 3 per series → the index started at 66.7.
  assert.equal(data[0].v, 100);
  assert.ok(Math.abs(data[2].v - (120 / 2 + 110 / 2)) < 1e-9);
});

test("equity curve: portfolio names the positions it could not price", () => {
  const specs = [
    { symbol: "A", value: (close) => 2 * close },
    { symbol: "B", value: (close) => 3 * close },
  ];
  const settled = [
    { status: "fulfilled", value: candles([10, 20]) },
    { status: "fulfilled", value: [] }, // too short to plot
  ];
  const { data, failed } = buildEquityCurve("portfolio", specs, settled);
  assert.deepEqual(failed, ["B"]);
  assert.deepEqual(data.map((p) => p.v), [20, 40]);
});

test("crypto screener: a coin whose klines failed is flagged, not silently filtered", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("/ticker/24hr")) {
      return new Response(JSON.stringify([
        { symbol: "BTCUSDT", lastPrice: "100", priceChangePercent: "1", quoteVolume: "900" },
        { symbol: "ETHUSDT", lastPrice: "10", priceChangePercent: "-1", quoteVolume: "800" },
      ]));
    }
    if (url.includes("ETHUSDT")) return new Response("bad", { status: 400 });
    const rows = Array.from({ length: 60 }, (_, i) => [0, 0, 0, 0, String(100 - i)]);
    return new Response(JSON.stringify(rows));
  };
  try {
    const data = await scanCrypto({ limit: 2 });
    assert.deepEqual(data.unreachable, ["ETHUSDT"], "old code returned no list at all");
    const eth = data.find((r) => r.symbol === "ETHUSDT");
    assert.equal(eth.metricsUnavailable, true);
    const f = { rsi: "oversold", trend: "any" };
    assert.ok(!applyFilters(data, f).some((r) => r.symbol === "ETHUSDT"));
    assert.deepEqual(unevaluable(data, f).map((r) => r.symbol), ["ETHUSDT"]);
    assert.deepEqual(unevaluable(data, { rsi: "any", trend: "any" }), [], "no indicator filter → nothing unchecked");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("quotes: keepStale returns the last good price marked stale, with its age", async () => {
  const realFetch = globalThis.fetch;
  let fail = false;
  globalThis.fetch = async () => {
    if (fail) return new Response("x", { status: 503 });
    return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 42 }, indicators: { quote: [{ close: [40, 41] }] } }] } }));
  };
  const realNow = Date.now;
  try {
    const entry = { market: "stock", symbol: "ZZZT", name: "Test" };
    const first = await fetchQuotes([entry], { keepStale: true });
    assert.equal(first.get("ZZZT").price, 42);
    assert.equal(first.get("ZZZT").stale, false);
    fail = true;
    Date.now = () => realNow() + 60_000; // past the 30 s client cache
    const second = await fetchQuotes([entry], { keepStale: true });
    assert.equal(second.get("ZZZT").price, 42, "old code dropped it to null");
    assert.equal(second.get("ZZZT").stale, true);
    assert.ok(Number.isFinite(second.get("ZZZT").asOf));
    const plain = await fetchQuotes([entry]);
    assert.equal(plain.get("ZZZT").price, null, "callers that don't opt in keep the old shape");
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
});

test("quotes: staleOrMissing says 'no quote' when there never was one", () => {
  const out = staleOrMissing({ symbol: "X" }, undefined);
  assert.equal(out.price, null);
  assert.equal(out.stale, true);
  assert.equal(out.asOf, null);
});
