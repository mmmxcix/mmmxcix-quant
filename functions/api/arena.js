// /api/arena — state for the live paper-trading arena (see src/lib/arena.js).
//
// The arena hosts order-book strategies that CANNOT be backtested: the
// micro-price reads live depth, and we have no historical book. They trade on
// paper against the real Binance book instead, and are judged on trades that
// actually happened.
//
// Storage reuses the argus_kv table under a fixed "arena:snapshot" key rather
// than a new table, so no migration is needed on a database that is already
// live. The key is a CONSTANT here — never bound from the request — because
// /api/argus previously let a caller read arbitrary rows that way.
//
// GET is public (paper trading, educational). POST is machine-token gated.

import { isAdminRequest } from "../_lib/auth.mjs";

const KEY = "arena:snapshot";
const LEDGER_CAP = 400;          // per strategy
const MAX_ENTRIES = 24;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a)), bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let d = 0;
  for (let i = 0; i < ab.length; i++) d |= ab[i] ^ bb[i];
  return d === 0;
}

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const num = (v) => (Number.isFinite(v) ? v : 0);

/** Accept only the shape we render. An agent bug must not be able to write
 *  arbitrary JSON into a public endpoint. */
function sanitiseEntry(e) {
  if (!e || typeof e !== "object") return null;
  const id = str(e.id, 64);
  if (!id) return null;
  const ledger = Array.isArray(e.ledger) ? e.ledger.slice(-LEDGER_CAP).map((t) => ({
    id: str(t.id, 80), symbol: str(t.symbol, 20), side: t.side === "short" ? "short" : "long",
    state: t.state === "open" ? "open" : "closed",
    entry: num(t.entry), exit: num(t.exit), stop: num(t.stop), target: num(t.target),
    stake: num(t.stake), riskAmt: num(t.riskAmt), fees: num(t.fees),
    pnl: num(t.pnl), R: num(t.R), reason: str(t.reason, 40),
    openedAt: num(t.openedAt), closedAt: num(t.closedAt),
  })) : [];
  return {
    id, label: str(e.label, 80), description: str(e.description, 400),
    symbol: str(e.symbol, 20),
    status: ["learning", "active", "evicted"].includes(e.status) ? e.status : "learning",
    startedAt: num(e.startedAt), evictedAt: num(e.evictedAt), evictReason: str(e.evictReason, 200),
    modelCoverage: num(e.modelCoverage), modelFittedAt: num(e.modelFittedAt),
    verdict: e.verdict && typeof e.verdict === "object" ? {
      status: str(e.verdict.status, 20), reason: str(e.verdict.reason, 200),
      stats: e.verdict.stats && typeof e.verdict.stats === "object" ? {
        n: num(e.verdict.stats.n), wins: num(e.verdict.stats.wins),
        winRate: num(e.verdict.stats.winRate), avgR: num(e.verdict.stats.avgR),
        sdR: num(e.verdict.stats.sdR), tStat: num(e.verdict.stats.tStat),
        pnl: num(e.verdict.stats.pnl), equity: num(e.verdict.stats.equity),
        maxDrawdownPct: num(e.verdict.stats.maxDrawdownPct),
      } : null,
    } : null,
    ledger,
  };
}

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: "db_not_bound" }, 503);

  const read = async () => {
    try {
      const row = await db.prepare("SELECT data FROM argus_kv WHERE key = ?").bind(KEY).first();
      return row ? JSON.parse(row.data) : null;
    } catch { return null; }
  };
  const write = (obj) => db.prepare(
    "INSERT INTO argus_kv (key, data, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
  ).bind(KEY, JSON.stringify(obj), Date.now()).run();

  if (request.method === "GET") {
    const snap = await read();
    return json({
      ok: true,
      entries: snap?.entries || [],
      updatedAt: snap?.updatedAt || 0,
      book: snap?.book || null,       // last seen top-of-book, for the live header
      scores: snap?.scores || [],
    });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

    // Human-side control: retire an entrant by hand. Session-gated, like the
    // argus command channel — a machine token must not be able to do this.
    if (body.command) {
      if (!(await isAdminRequest(env, request))) return json({ error: "unauthorized" }, 401);
      const id = str(body.command.id, 64);
      if (body.command.type !== "retire" || !id) return json({ error: "bad_command" }, 400);
      const snap = (await read()) || { entries: [] };
      const entries = (snap.entries || []).map((e) => (e.id === id && e.status !== "evicted"
        ? { ...e, status: "evicted", evictedAt: Date.now(), evictReason: "retired by hand" }
        : e));
      try { await write({ ...snap, entries, updatedAt: Date.now() }); }
      catch { return json({ error: "db_write_failed" }, 503); }
      return json({ ok: true, retired: id });
    }

    if (!env.DEV_ACCESS_TOKEN || !safeEqual(body.token || "", env.DEV_ACCESS_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }

    if (body.reset === true) {
      try { await db.prepare("DELETE FROM argus_kv WHERE key = ?").bind(KEY).run(); }
      catch { return json({ error: "db_reset_failed" }, 503); }
      return json({ ok: true, reset: true });
    }

    if (!Array.isArray(body.entries)) return json({ error: "bad_entries" }, 400);
    const entries = body.entries.slice(0, MAX_ENTRIES).map(sanitiseEntry).filter(Boolean);
    const book = body.book && typeof body.book === "object" ? {
      symbol: str(body.book.symbol, 20), bid: num(body.book.bid), ask: num(body.book.ask),
      micro: num(body.book.micro), at: num(body.book.at),
    } : null;

    // Forecast error per market — the fee-independent evidence the page leads with.
    const scores = Array.isArray(body.scores) ? body.scores.slice(0, 12).map((x) => ({
      symbol: str(x.symbol, 20), n: num(x.n), horizonMs: num(x.horizonMs),
      midTicks: Number.isFinite(x.midTicks) ? x.midTicks : null,
      weightedTicks: Number.isFinite(x.weightedTicks) ? x.weightedTicks : null,
      microTicks: Number.isFinite(x.microTicks) ? x.microTicks : null,
      modelCoverage: num(x.modelCoverage),
    })) : [];

    try { await write({ entries, book, scores, updatedAt: Date.now() }); }
    catch { return json({ error: "db_write_failed" }, 503); }
    return json({ ok: true, saved: entries.length });
  }

  return json({ error: "method_not_allowed" }, 405);
}
