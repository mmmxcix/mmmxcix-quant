// The board: one declared retrieval surface over the agents, the market and the news.
//
// These tests hold the three invariants the catalog's header promises, because
// they are the ones that stop this layer from becoming either a security hole or
// a 600 KB JSON dump with a nicer name.

import { test } from "node:test";
import assert from "node:assert/strict";

import { coerceArgs, parseDuration, ArgError } from "../src/lib/board/args.js";
import { toMs, ago, table, signedR } from "../src/lib/board/format.js";
import { RESOURCES, RESOURCE_IDS, SOURCES, listResources, resolve } from "../src/lib/board/catalog.js";
import { sessionOf } from "../src/lib/argus/learn.js";

const NOW = 1_786_600_000_000;
const H = 3_600_000;

// ── fixtures ────────────────────────────────────────────────────────────────
// Shaped after the live payloads (measured 13 Aug 2026: 98 closed trades,
// 45 fields per row, 54 journal entries, 150 headlines).

function trade(i, over = {}) {
  const openedAt = NOW - (i + 1) * 3 * H;
  const R = over.R ?? (i % 3 === 0 ? 1.8 : -1);
  return {
    id: `t${i}`,
    symbol: ["BTCUSDT", "ETHUSDT", "SOLUSDT"][i % 3],
    side: i % 2 ? "long" : "short",
    kind: ["breakout", "mean-reversion", "liquidity-sweep"][i % 3],
    outcome: R > 0 ? "target" : "stop",
    R,
    pnl: R * 100,
    riskAmt: 100,
    plannedR: 1.5,
    openedAt,
    exitAt: openedAt + H,
    evidence: "x".repeat(400), // the bulk a compact projection must drop
    riskChecks: { pass: true, heatUsedPct: 10.4 },
    ...over,
  };
}

const snapshot = (n = 30) => ({
  state: {
    at: NOW - 2 * 60_000,
    equity: 7595, markEquity: 7590, unrealized: -5, dayPnl: -18.4,
    open: 2, forming: 1, heatPct: 0.042, heatCapPct: 0.12, // fractions, as the agent writes them
    portfolioLev: 1.4, portfolioLevCap: 3, universe: 41, halted: false,
    learnRefusedPct: 41, learnConsidered: 120,
    pace: { open: 2, maxConcurrent: 4, openedToday: 2, maxPerDay: 12, blocked: false },
    lessons: [
      { text: "trades in the Asia session: 19% win, −0.55R over 31 trades → suppress", verdict: "losing", n: 31 },
      { text: "liquidity-sweep shorts: 55% win, +0.31R over 11 trades → keep", verdict: "winning", n: 11 },
    ],
  },
  theses: [
    { id: "o1", state: "open", symbol: "BTCUSDT", side: "long", kind: "breakout", entry: 100, stop: 95, target: 115, currentPrice: 104, unrealizedR: 0.8, maxFavR: 1.1, maxAdvR: -0.3, openedAt: NOW - 4 * H, reason: "r" },
    { id: "c1", state: "closed", symbol: "ETHUSDT" },
  ],
  journal: [
    { id: "j1", at: NOW - 2 * H, symbol: "LINKUSDT", kind: "mean-reversion", side: "short", outcome: "stop", R: -1, verdict: "bad-process", cause: "no room for the counter-trend continuation" },
    { id: "j2", at: NOW - 40 * 24 * H, symbol: "BTCUSDT", kind: "breakout", side: "long", outcome: "target", R: 2, verdict: "good", cause: "old entry, outside a 7d window" },
  ],
  skills: [{ scope: { kind: "mean-reversion", symbol: "SOLUSDT" }, lesson: "wait for the retest" }],
  ledger: Array.from({ length: n }, (_, i) => trade(i)),
});

const newsRaw = {
  meta: {
    fetchedAt: NOW - 5 * 60_000,
    feeds: [
      { source: "Federal Reserve", tier: 1, ok: true },
      { source: "CNBC", tier: 2, ok: true },
      { source: "Dead Feed", tier: 2, ok: false },
    ],
  },
  items: [
    { title: "Fed holds rates", description: "The FOMC left rates unchanged", source: "Federal Reserve", category: "business", tier: 1, pubDate: new Date(NOW - 3 * H).toUTCString(), link: "#" },
    { title: "Bitcoin rallies", description: "BTC up 4%", source: "CNBC", category: "crypto", tier: 2, pubDate: new Date(NOW - 8 * H).toUTCString(), link: "#" },
    { title: "Ancient news", description: "old", source: "CNBC", category: "markets", tier: 2, pubDate: new Date(NOW - 80 * H).toUTCString(), link: "#" },
  ],
};

// ── 1. catalog invariants ───────────────────────────────────────────────────

test("every resource declares visibility, a known source, a schema, a selector and a digest", () => {
  assert.ok(RESOURCE_IDS.length > 0);
  for (const id of RESOURCE_IDS) {
    const r = RESOURCES[id];
    assert.ok(["public", "admin"].includes(r.visibility), `${id} visibility`);
    assert.ok(SOURCES[r.source], `${id} source ${r.source} is declared`);
    assert.equal(typeof r.summary, "string");
    assert.ok(r.summary.length > 20, `${id} summary explains what it answers`);
    assert.equal(typeof r.select, "function");
    assert.equal(typeof r.digest, "function");
    for (const [name, spec] of Object.entries(r.args)) {
      assert.ok(
        ["string", "symbol", "enum", "bool", "int", "number", "duration", "list"].includes(spec.type),
        `${id}.${name} has a known type`,
      );
      if (spec.type === "enum") assert.ok(Array.isArray(spec.values) && spec.values.length, `${id}.${name} enum is closed`);
      if (spec.type === "list") assert.ok(spec.of, `${id}.${name} list declares its item type`);
    }
  }
});

test("no resource can name a storage key, a path or a URL", () => {
  // The /api/argus authorization bypass (CWE-639) was exactly this: a caller's
  // string bound into a D1 key lookup. The board multiplies that surface if it
  // ever allows the same, so the denylist is a test, not a convention.
  const forbidden = ["key", "path", "url", "table", "query", "sql", "what"];
  for (const id of RESOURCE_IDS) {
    for (const name of Object.keys(RESOURCES[id].args)) {
      assert.ok(!forbidden.includes(name.toLowerCase()), `${id} must not accept "${name}"`);
    }
  }
});

test("D1 sources read a fixed allowlist of keys", () => {
  const keys = Object.values(SOURCES).filter((s) => s.kind === "d1").map((s) => s.key).sort();
  assert.deepEqual(keys, ["arena:snapshot", "kronos:snapshot", "snapshot"]);
  for (const s of Object.values(SOURCES)) {
    if (s.kind === "d1") assert.equal(typeof s.key, "string", "a D1 key is a constant, never a function of args");
    assert.ok(s.staleAfterMs > 0, "every source declares how stale it may be");
  }
});

test("listResources hides admin resources from a public caller", () => {
  const pub = listResources({ visibility: "public" });
  assert.ok(pub.every((r) => r.visibility === "public"));
  assert.ok(listResources({ visibility: "admin" }).length >= pub.length);
  assert.ok(pub[0].args !== undefined, "the listing carries the argument schema — it is the chat's tool list too");
});

// ── 2. argument coercion ────────────────────────────────────────────────────

test("unknown arguments are refused, not ignored", () => {
  assert.throws(() => coerceArgs({ limit: { type: "int" } }, { limit: 5, sneaky: "x" }), ArgError);
});

test("a missing required argument is refused; optional ones take their default", () => {
  assert.throws(() => coerceArgs({ symbol: { type: "symbol", required: true } }, {}), ArgError);
  assert.equal(coerceArgs({ limit: { type: "int", default: 25 } }, {}).limit, 25);
});

test("enums are closed and symbols are constrained to real ticker characters", () => {
  const schema = { side: { type: "enum", values: ["long", "short"] }, symbol: { type: "symbol" } };
  assert.equal(coerceArgs(schema, { side: "long" }).side, "long");
  assert.throws(() => coerceArgs(schema, { side: "sideways" }), ArgError);
  assert.equal(coerceArgs(schema, { symbol: "btcusdt" }).symbol, "BTCUSDT");
  assert.equal(coerceArgs(schema, { symbol: "^gspc" }).symbol, "^GSPC");
  assert.throws(() => coerceArgs(schema, { symbol: "../../etc/passwd" }), ArgError);
  assert.throws(() => coerceArgs(schema, { symbol: "BTC USDT" }), ArgError);
});

test("limits clamp instead of failing", () => {
  const schema = { limit: { type: "int", min: 1, max: 200, default: 25 } };
  assert.equal(coerceArgs(schema, { limit: 5000 }).limit, 200);
  assert.equal(coerceArgs(schema, { limit: -3 }).limit, 1);
});

test("durations parse to milliseconds, and \"all\" means no window", () => {
  assert.equal(parseDuration("24h"), 24 * H);
  assert.equal(parseDuration("7d"), 7 * 24 * H);
  assert.equal(parseDuration("all"), null);
  assert.throws(() => parseDuration("yesterday"), ArgError);
});

// ── 3. the unit trap ────────────────────────────────────────────────────────

test("seconds and milliseconds are normalised at the edge", () => {
  // Argus stores milliseconds, Kronos (Python) stores seconds. A chart marker
  // placed 1000× too late renders nothing and reports no error, which is why
  // this normalisation belongs in the layer and not in each caller.
  assert.equal(toMs(1786550303), 1786550303000);
  assert.equal(toMs(1786550303000), 1786550303000);
  assert.equal(toMs(null), 0);
  assert.equal(ago(0), "never");
});

// ── 4. Argus resources ──────────────────────────────────────────────────────

test("argus.status reports the pace and says when it blocks new entries", () => {
  const r = resolve("argus.status", {}, snapshot(), { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.stale, false);
  assert.match(r.digest, /Pace 2\/12 today/);
  // The agent stores heat as a FRACTION; the board normalises it to a percentage,
  // so "4.2% of 12.0%" is right and "0.0% of 0.1%" (the first live reading) was not.
  assert.match(r.digest, /Heat 4\.2% of 12\.0%/);
  assert.equal(r.data.heatPct, 4.2);
  assert.doesNotMatch(r.digest, /BLOCKED/);

  const blocked = snapshot();
  blocked.state.pace.blocked = true;
  assert.match(resolve("argus.status", {}, blocked, { now: NOW }).digest, /BLOCKED/);
});

test("argus.positions returns only open theses, projected small", () => {
  const r = resolve("argus.positions", {}, snapshot(), { now: NOW });
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].symbol, "BTCUSDT");
  assert.equal(r.data[0].evidence, undefined, "the 400-character evidence blob does not travel");
});

test("argus.performance slices the book and keeps the sample size with every average", () => {
  const r = resolve("argus.performance", { by: "session", minN: 1 }, snapshot(30), { now: NOW });
  assert.equal(r.data.overall.n, 30);
  const sessions = r.data.buckets.map((b) => b.key);
  assert.ok(sessions.every((s) => ["asia", "london", "ny", "off"].includes(s)));
  assert.equal(r.data.buckets.reduce((a, b) => a + b.n, 0), 30, "every trade lands in exactly one bucket");
  assert.match(r.digest, /trades · .* wins · Ø/);
  for (const b of r.data.buckets) assert.match(r.digest, new RegExp(`${b.key}\\s`), "each bucket shows in the digest");
});

test("argus.performance honours the window and refuses to invent an answer for an empty one", () => {
  const r = resolve("argus.performance", { window: "1h" }, snapshot(30), { now: NOW });
  assert.equal(r.data.overall.n, 0);
  assert.equal(r.digest, "No closed trades in this window.");
});

test("argus.performance hides buckets thinner than minN rather than showing a one-trade average", () => {
  const r = resolve("argus.performance", { by: "symbol", minN: 100 }, snapshot(30), { now: NOW });
  assert.deepEqual(r.data.buckets, []);
  assert.match(r.digest, /No bucket of symbol reaches the minimum sample/);
});

test("argus.trades filters, caps and reports how many it did not show", () => {
  const r = resolve("argus.trades", { side: "long", limit: 3 }, snapshot(30), { now: NOW });
  assert.ok(r.data.matched > 3);
  assert.equal(r.data.shown, 3);
  assert.ok(r.data.trades.every((t) => t.side === "long"));
  assert.match(r.digest, /showing 3/);
  assert.equal(r.data.trades[0].session, sessionOf(r.data.trades[0].openedAt));
});

test("argus.trades sorts newest first and computes R even when the row lacks it", () => {
  const snap = snapshot(5);
  delete snap.ledger[0].R; // legacy row: pnl and riskAmt only
  const r = resolve("argus.trades", {}, snap, { now: NOW });
  assert.ok(r.data.trades[0].exitAt >= r.data.trades[1].exitAt);
  const legacy = r.data.trades.find((t) => t.id === "t0");
  assert.equal(legacy.R, 1.8, "tradeR() fills it from pnl/riskAmt instead of counting it as zero");
});

test("argus.lessons keeps the verdict counts and the retained skills", () => {
  const r = resolve("argus.lessons", {}, snapshot(), { now: NOW });
  assert.equal(r.data.total, 2);
  assert.equal(r.data.counts.losing, 1);
  assert.match(r.digest, /refuses 41% of considered setups/);
  assert.match(r.digest, /Retained skills/);
});

test("argus.lessons says so when a filter matches nothing", () => {
  // The live ledger has eight lessons and NONE of them winning. A digest that
  // printed the "8 lessons" header over an empty list read as if the filter had
  // simply not been applied.
  const r = resolve("argus.lessons", { verdict: "neutral" }, snapshot(), { now: NOW });
  assert.equal(r.data.matched, 0);
  assert.match(r.digest, /No lesson with verdict "neutral"/);
});

test("market.bias reports the absence of a provider instead of an empty read", () => {
  const none = resolve("market.bias", { symbol: "AAPL" }, { ok: true, hasLLM: false }, { now: NOW });
  assert.match(none.digest, /no synthesised read/);
  const full = resolve("market.bias", { symbol: "AAPL" }, {
    hasLLM: true, note: "Steady.", confidence: 0.65, anchorPrice: 305.26, cached: true,
    horizon: { short: "neutral", medium: "neutral", long: "long" },
    targets: { short: 312, medium: 322, long: 340 },
    drivers: ["16% YoY revenue growth"], at: NOW - 60_000,
  }, { now: NOW });
  assert.match(full.digest, /short neutral → 312\.00/);
  assert.match(full.digest, /long long → 340\.00/);
  assert.equal(full.stale, false);
});

test("argus.journal windows by entry time", () => {
  const r = resolve("argus.journal", { window: "7d" }, snapshot(), { now: NOW });
  assert.equal(r.data.entries.length, 1, "the 40-day-old entry is outside the window");
  assert.match(r.digest, /bad-process/);
});

// ── 5. staleness ────────────────────────────────────────────────────────────

test("a source that went quiet is reported stale, not served as if it were now", () => {
  const old = snapshot();
  old.state.at = NOW - 3 * H;
  const r = resolve("argus.status", {}, old, { now: NOW });
  assert.equal(r.stale, true);
  assert.equal(r.asOf, NOW - 3 * H);
});

test("a source that never reported is stale and says so in words", () => {
  const r = resolve("kronos.state", {}, null, { now: NOW });
  assert.equal(r.stale, true);
  assert.equal(r.digest, "Kronos has not reported yet.");
});

// ── 6. news ─────────────────────────────────────────────────────────────────

test("news.headlines filters by tier, text and window, and names the dead feeds", () => {
  const all = resolve("news.headlines", { window: "24h" }, newsRaw, { now: NOW });
  assert.equal(all.data.matched, 2, "the 80h-old item is outside a 24h window");
  assert.match(all.digest, /2\/3 feeds live/);
  assert.match(all.digest, /down: Dead Feed/);

  const tier1 = resolve("news.headlines", { tier: 1, window: "24h" }, newsRaw, { now: NOW });
  assert.equal(tier1.data.matched, 1);

  const q = resolve("news.headlines", { q: "fomc", window: "24h" }, newsRaw, { now: NOW });
  assert.equal(q.data.matched, 1, "the match reads the description, not only the title");
});

// ── 7. the size budget ──────────────────────────────────────────────────────

test("digests stay small even at the ledger cap — the whole reason the layer exists", () => {
  // 500 closed trades is the cap /api/argus enforces; the raw snapshot at that
  // size is ~620 KB. A digest that grew with it would defeat the purpose.
  const big = snapshot(500);
  const cases = [
    ["argus.status", {}],
    ["argus.positions", {}],
    ["argus.performance", { by: "kind" }],
    ["argus.trades", { limit: 200 }],
    ["argus.lessons", {}],
    ["argus.journal", {}],
  ];
  for (const [id, args] of cases) {
    const r = resolve(id, args, big, { now: NOW });
    assert.ok(r.digest.length < 12_000, `${id} digest is ${r.digest.length} chars`);
  }
  // The default read of the whole book fits in a couple of screens.
  const perf = resolve("argus.performance", { by: "session" }, big, { now: NOW });
  assert.ok(perf.digest.length < 1_200, `session breakdown is ${perf.digest.length} chars`);
});

// ── 8. formatting ───────────────────────────────────────────────────────────

test("R is always signed, and a table aligns without a dependency", () => {
  assert.equal(signedR(0.5), "+0.50R");
  assert.equal(signedR(-0.5), "−0.50R");
  assert.equal(signedR(undefined), "—");
  const t = table(["a", "bb"], [["x", "1"], ["yyy", "22"]]);
  assert.equal(t.split("\n").length, 3);
  assert.ok(t.split("\n").every((l) => !/\s$/.test(l)), "no trailing whitespace");
});

test("an unknown resource fails as a caller error, not as a crash", () => {
  const r = resolve("argus.secrets", {}, snapshot(), { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.error, "unknown_resource");
});
