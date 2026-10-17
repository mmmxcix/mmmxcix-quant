import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchQuotes, parseQuoteBatch, parseSparkBatch } from "../src/lib/quotes.js";
import { ALL_ENTRIES } from "../src/lib/universe.js";
import { visibleInterval } from "../src/lib/visiblePoll.js";

// Every /api/yahoo request is a Pages Function invocation. The Monitor used to
// spend one per stock symbol per tick (28); it must now spend one.

const v7 = (symbols) => ({
  quoteResponse: {
    result: symbols.map((symbol, i) => ({
      symbol, regularMarketPrice: 100 + i, regularMarketChangePercent: 1.5, regularMarketPreviousClose: (100 + i) / 1.015,
    })),
    error: null,
  },
});

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return impl(String(url), init); };
  try { return { result: await fn(), calls }; } finally { globalThis.fetch = real; }
}

const symbolsOf = (url) => decodeURIComponent(/symbols=([^&]+)/.exec(url)[1]).split(",");

test("Monitor tick: all stock symbols in ONE /api/yahoo request", async () => {
  const stocks = ALL_ENTRIES.filter((e) => e.market !== "crypto");
  assert.equal(stocks.length, 28);
  const { result, calls } = await withFetch(async (url) => {
    if (url.includes("binance")) return new Response("[]");
    return new Response(JSON.stringify(v7(symbolsOf(url))));
  }, () => fetchQuotes(ALL_ENTRIES));
  const yahoo = calls.filter((u) => u.startsWith("/api/yahoo"));
  assert.equal(yahoo.length, 1, `expected 1 Yahoo call, got ${yahoo.length}`);
  assert.ok(yahoo[0].startsWith("/api/yahoo/v7/finance/quote?symbols="));
  for (const e of stocks) {
    const q = result.get(e.symbol);
    assert.ok(Number.isFinite(q.price), `${e.symbol} priced`);
    assert.equal(q.changePct, 1.5);
  }
});

test("a symbol the batch leaves out falls back to the per-symbol path, alone", async () => {
  const entries = [
    { market: "stock", symbol: "BTA1" }, { market: "stock", symbol: "BTA2" }, { market: "stock", symbol: "BTA3" },
  ];
  const { result, calls } = await withFetch(async (url) => {
    if (url.includes("/v7/finance/quote")) return new Response(JSON.stringify(v7(["BTA1", "BTA2"])));
    return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 9 }, indicators: { quote: [{ close: [8, 9] }] } }] } }));
  }, () => fetchQuotes(entries));
  assert.equal(calls.length, 2, "one batch + one fallback for the missing symbol");
  assert.ok(calls[1].includes("/v8/finance/chart/BTA3"));
  assert.equal(result.get("BTA3").price, 9);
});

test("a failed batch degrades to the old per-symbol path, never to blanks", async () => {
  const entries = [{ market: "stock", symbol: "BTB1" }, { market: "stock", symbol: "BTB2" }];
  const { result, calls } = await withFetch(async (url) => {
    if (url.includes("/v7/finance/quote")) return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 5 }, indicators: { quote: [{ close: [4, 5] }] } }] } }));
  }, () => fetchQuotes(entries));
  assert.equal(calls.length, 3);
  assert.equal(result.get("BTB1").price, 5);
  assert.equal(result.get("BTB2").price, 5);
});

test("parseQuoteBatch: percent as given, derived from prevClose when missing, unpriced rows skipped", () => {
  const m = parseQuoteBatch({ quoteResponse: { result: [
    { symbol: "a", regularMarketPrice: 110, regularMarketChangePercent: 2.5 },
    { symbol: "B", regularMarketPrice: 110, regularMarketPreviousClose: 100 },
    { symbol: "C" },
  ] } });
  assert.equal(m.get("A").changePct, 2.5);
  assert.ok(Math.abs(m.get("B").changePct - 10) < 1e-9);
  assert.equal(m.has("C"), false);
});

test("parseSparkBatch: accepts both spark response shapes", () => {
  const flat = parseSparkBatch({ AAPL: { symbol: "AAPL", timestamp: [1, 2, 3], close: [1, null, 3] } });
  assert.deepEqual(flat.get("AAPL"), [1, 3]);
  const nested = parseSparkBatch({ spark: { result: [{ symbol: "MSFT", response: [{ indicators: { quote: [{ close: [4, 5, 6] }] } }] }] } });
  assert.deepEqual(nested.get("MSFT"), [4, 5, 6]);
});

test("visibleInterval: no ticks while hidden, one catch-up on return", async () => {
  const listeners = {};
  globalThis.document = {
    hidden: true,
    addEventListener: (t, f) => { listeners[t] = f; },
    removeEventListener: (t) => { delete listeners[t]; },
  };
  try {
    let n = 0;
    const stop = visibleInterval(() => { n++; }, 20);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(n, 0, "hidden tab must not poll");
    document.hidden = false;
    listeners.visibilitychange();
    assert.equal(n, 1, "overdue tick runs immediately on return");
    stop();
    assert.equal(listeners.visibilitychange, undefined);
  } finally {
    delete globalThis.document;
  }
});

test("yahoo proxy: v7 quote is allowed, carries the crumb, and re-handshakes once on 401", async () => {
  const { onRequest } = await import("../functions/api/yahoo/[[path]].js");
  const store = new Map();
  globalThis.caches = { default: {
    match: async (req) => store.get(req.url)?.clone(),
    put: async (req, res) => { store.set(req.url, res); },
  } };
  let crumbN = 0;
  const upstream = [];
  try {
    const { result } = await withFetch(async (url) => {
      if (url === "https://fc.yahoo.com/") return new Response("", { headers: { "set-cookie": "A3=x; path=/" } });
      if (url.includes("getcrumb")) return new Response(`crumb${++crumbN}`);
      upstream.push(url);
      // The first (cached-session) crumb is "expired"; the fresh one works.
      return url.includes("crumb=crumb1")
        ? new Response("{}", { status: 401 })
        : new Response(JSON.stringify(v7(["AAPL"])));
    }, () => onRequest({
      request: new Request("https://quant.test/api/yahoo/v7/finance/quote?symbols=AAPL"),
      params: { path: ["v7", "finance", "quote"] },
    }));
    assert.equal(result.status, 200);
    assert.equal(upstream.length, 2);
    assert.ok(upstream[1].includes("crumb=crumb2"));
    assert.equal(result.headers.get("cache-control"), "public, max-age=30");
  } finally {
    delete globalThis.caches;
  }
});
