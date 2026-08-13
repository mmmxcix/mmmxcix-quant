// /api/board — the one retrieval surface over everything the tool knows.
//
// The catalog (src/lib/board/catalog.js) declares WHAT is answerable and does all
// the selecting and aggregating in pure, tested functions. This file only does
// the part that needs the network: fetch a source's bytes, enforce who may read
// it, and hand the pair to the catalog. Keeping the split there is what lets
// test/board.test.mjs exercise every resource offline against recorded snapshots.
//
//   GET  /api/board                                → the catalog listing
//   GET  /api/board?resource=argus.status&…        → one read, args from the query
//   POST /api/board { reads:[{resource,args},…] }  → up to 12 reads, one round trip
//
// Batching is not a nicety: a page (and later a chat turn) that asks six
// questions of Argus must not read the same 171 KB row six times. Sources are
// fetched once per request and memoised.
//
// READ-ONLY. Argus's command channel (close / cancel / reset) lives in
// /api/argus and deliberately does not appear here — a read-only allowlist can
// be public, an action surface cannot.

import { isAdminRequest } from "../_lib/auth.mjs";
import { rateLimit, clientIp } from "../_lib/ratelimit.mjs";
import { argsFor, getResource, listResources, resolve, SOURCES } from "../../src/lib/board/catalog.js";
import { ArgError } from "../../src/lib/board/args.js";
import { panelEntries, findEntry } from "../../src/lib/universe.js";

const MAX_READS = 12;
const RATE = { limit: 40, windowMs: 60_000 };

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

// ── outbound helpers ────────────────────────────────────────────────────────

const BINANCE = "https://api.binance.com/api/v3";

/**
 * Binance and Yahoo send no useful cache headers, and the monitor asks for the
 * same 30 tickers on every visit. The edge cache costs nothing and keeps a busy
 * page from turning into a rate-limit problem at the exchange.
 */
async function cachedFetch(url, ttl) {
  const cache = caches.default;
  const key = new Request(url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const body = await res.text();
  await cache.put(key, new Response(body, {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
  }));
  return JSON.parse(body);
}

const YAHOO_INTERVAL = { "5m": "5m", "15m": "15m", "1h": "60m", "1d": "1d", "1wk": "1wk" };
const INTERVAL_SEC = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1wk": 604800 };
const RANGE_SEC = {
  "5d": 5 * 86400, "1mo": 31 * 86400, "3mo": 92 * 86400,
  "6mo": 183 * 86400, "1y": 365 * 86400, "2y": 730 * 86400, "5y": 1826 * 86400,
};

async function yahooChart(origin, symbol, { range = "5d", interval = "1d" } = {}) {
  const url = `${origin}/api/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const body = await res.json();
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(body?.chart?.error?.description || `no data for ${symbol}`);
  return result;
}

function yahooCandles(result) {
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue; // holidays and gaps
    out.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return out;
}

/** Snapshot quotes for a mixed list of instruments. One Binance call, one Yahoo call each. */
async function fetchQuotes(origin, entries) {
  const crypto = entries.filter((e) => e.market === "crypto");
  const stocks = entries.filter((e) => e.market !== "crypto");
  const byKey = new Map();

  if (crypto.length) {
    const symbols = JSON.stringify(crypto.map((e) => e.symbol.toUpperCase()));
    try {
      const rows = await cachedFetch(`${BINANCE}/ticker/24hr?symbols=${encodeURIComponent(symbols)}`, 30);
      for (const r of Array.isArray(rows) ? rows : [rows]) {
        byKey.set(r.symbol, { price: +r.lastPrice, changePct: +r.priceChangePercent });
      }
    } catch { /* reported as a missing quote below, never as a fake one */ }
  }

  // Yahoo is one request per symbol; keep the fan-out modest and parallel.
  await Promise.all(stocks.map(async (e) => {
    try {
      const result = await yahooChart(origin, e.symbol);
      const closes = (result.indicators?.quote?.[0]?.close || []).filter((c) => c != null);
      const price = result.meta?.regularMarketPrice ?? closes[closes.length - 1];
      const prev = result.meta?.chartPreviousClose ?? closes[closes.length - 2];
      byKey.set(e.symbol.toUpperCase(), {
        price,
        changePct: Number.isFinite(price) && Number.isFinite(prev) && prev !== 0 ? ((price - prev) / prev) * 100 : null,
      });
    } catch { /* same: missing, not invented */ }
  }));

  return {
    at: Date.now(),
    quotes: entries.map((e) => ({
      symbol: e.symbol, name: e.name, market: e.market,
      price: byKey.get(e.symbol.toUpperCase())?.price ?? null,
      changePct: byKey.get(e.symbol.toUpperCase())?.changePct ?? null,
    })),
  };
}

async function fetchCandles(origin, a) {
  if (a.market === "crypto") {
    const sec = INTERVAL_SEC[a.interval] || 86400;
    const need = Math.min(1000, Math.max(10, Math.ceil((RANGE_SEC[a.range] || RANGE_SEC["3mo"]) / sec)));
    const bin = a.interval === "1wk" ? "1w" : a.interval;
    const rows = await cachedFetch(
      `${BINANCE}/klines?symbol=${encodeURIComponent(a.symbol)}&interval=${bin}&limit=${need}`,
      a.interval === "1d" || a.interval === "1wk" ? 900 : 60,
    );
    return {
      at: Date.now(),
      candles: rows.map((r) => ({
        time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
      })),
    };
  }
  const interval = YAHOO_INTERVAL[a.interval];
  // Said plainly rather than silently substituted: Yahoo has no 4h bar, and a
  // layer that quietly served 1h under a 4h label would be worse than an error.
  if (!interval) throw new ArgError("interval_unavailable", `${a.interval} exists for crypto only; Yahoo has no such bar`);
  return { at: Date.now(), candles: yahooCandles(await yahooChart(origin, a.symbol, { range: a.range, interval })) };
}

// ── source fetching, memoised per request ───────────────────────────────────

function makeLoader({ env, origin }) {
  const cache = new Map();
  return async function load(sourceName, args) {
    const src = SOURCES[sourceName];
    // Args only reach a source through the resource's own coerced schema, and
    // only these two sources vary by them at all — everything else is a constant.
    const cacheKey = src.kind === "candles"
      ? `candles:${args.symbol}:${args.market}:${args.interval}:${args.range}`
      : src.kind === "quotes"
        ? `quotes:${args.symbols ? args.symbols.join(",") : args.panel}`
        : sourceName === "bias" ? `bias:${args.symbol}:${args.market}` : sourceName;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const p = (async () => {
      switch (src.kind) {
        case "d1": {
          if (!env.DB) throw new Error("db_not_bound");
          const row = await env.DB.prepare("SELECT data FROM argus_kv WHERE key = ?").bind(src.key).first();
          return row ? JSON.parse(row.data) : null;
        }
        case "http": {
          const res = await fetch(`${origin}${src.path(args)}`);
          if (!res.ok) throw new Error(`${sourceName} ${res.status}`);
          return res.json();
        }
        case "quotes": {
          const entries = args.symbols
            ? args.symbols.map((s) => findEntry(s) || { symbol: s, name: s, market: /USDT$|USDC$/.test(s) ? "crypto" : "stock" })
            : panelEntries(args.panel);
          return fetchQuotes(origin, entries);
        }
        case "candles":
          return fetchCandles(origin, args);
        default:
          throw new Error(`unknown source kind ${src.kind}`);
      }
    })();
    cache.set(cacheKey, p);
    return p;
  };
}

// ── one read ────────────────────────────────────────────────────────────────

async function runRead(load, { resource, args }, { visibility, now }) {
  const res = getResource(resource);
  if (!res) return { resource, ok: false, error: "unknown_resource" };
  if (res.visibility === "admin" && visibility !== "admin") {
    return { resource, ok: false, error: "unauthorized" };
  }
  try {
    // The source needs coerced arguments to build its request, and the catalog
    // owns the schema — so validation happens there, once, in both steps.
    const coerced = argsFor(resource, args || {});
    const raw = await load(res.source, coerced);
    return resolve(resource, args || {}, raw, { now });
  } catch (e) {
    if (e instanceof ArgError) return { resource, ok: false, error: e.code, detail: e.message };
    // Upstream trouble is reported as such. A retrieval layer that turns a dead
    // feed into an empty list teaches its reader something false.
    return { resource, ok: false, error: "source_unavailable", detail: String(e.message || e).slice(0, 160) };
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = url.origin;
  const now = Date.now();

  const gate = rateLimit(`board:${clientIp(request)}`, RATE.limit, RATE.windowMs);
  if (!gate.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retryAfter: gate.retryAfter }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(gate.retryAfter) },
    });
  }

  const visibility = (await isAdminRequest(env, request).catch(() => false)) ? "admin" : "public";
  const load = makeLoader({ env, origin });

  if (request.method === "GET") {
    const resource = url.searchParams.get("resource");
    if (!resource) {
      return json({ ok: true, at: now, visibility, resources: listResources({ visibility }) }, 200, 300);
    }
    const args = {};
    for (const [k, v] of url.searchParams) if (k !== "resource") args[k] = v;
    const read = await runRead(load, { resource, args }, { visibility, now });
    return json({ ok: true, at: now, reads: [read] }, read.ok ? 200 : 400);
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const reads = Array.isArray(body?.reads) ? body.reads.slice(0, MAX_READS) : null;
    if (!reads?.length) return json({ error: "no_reads" }, 400);
    const out = await Promise.all(
      reads.map((r) => runRead(load, { resource: String(r?.resource || ""), args: r?.args }, { visibility, now })),
    );
    return json({ ok: true, at: now, visibility, reads: out });
  }

  return json({ error: "method_not_allowed" }, 405);
}
