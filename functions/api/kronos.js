// /api/kronos — forecasts and the scoreboard from the Kronos service
// (scripts/kronos/forecast.py), which runs on the PC because Kronos is a
// PyTorch model and Pages cannot host one.
//
// Same storage arrangement as /api/arena: one fixed key in argus_kv, never
// bound from the request. GET is public; POST is machine-token gated.

const KEY = "kronos:snapshot";
const MAX_FORECASTS = 12;
const MAX_BARS = 240;

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

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: "db_not_bound" }, 503);

  const read = async () => {
    try {
      const row = await db.prepare("SELECT data FROM argus_kv WHERE key = ?").bind(KEY).first();
      return row ? JSON.parse(row.data) : null;
    } catch { return null; }
  };

  if (request.method === "GET") {
    const snap = await read();
    return json({
      ok: true,
      forecasts: snap?.forecasts || [],
      scoreboard: snap?.scoreboard || [],
      scoredCount: snap?.scoredCount || 0,
      account: snap?.account || null,
      updatedAt: snap?.updatedAt || 0,
    });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!env.DEV_ACCESS_TOKEN || !safeEqual(body.token || "", env.DEV_ACCESS_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }

    const forecasts = Array.isArray(body.forecasts) ? body.forecasts.slice(0, MAX_FORECASTS).map((f) => ({
      symbol: str(f.symbol, 20), interval: str(f.interval, 8), model: str(f.model, 16),
      at: num(f.at), lastClose: num(f.lastClose), lastTime: num(f.lastTime),
      forecast: Array.isArray(f.forecast) ? f.forecast.slice(0, MAX_BARS).map((b) => ({
        time: num(b.time), open: num(b.open), high: num(b.high), low: num(b.low), close: num(b.close),
      })) : [],
    })) : [];

    const scoreboard = Array.isArray(body.scoreboard) ? body.scoreboard.slice(0, MAX_FORECASTS).map((s) => ({
      symbol: str(s.symbol, 20), n: num(s.n),
      beatNaivePct: num(s.beatNaivePct), avgSkillPct: num(s.avgSkillPct),
      directionPct: num(s.directionPct),
    })) : [];

    // The paper account: budget, equity and every decision including the ones
    // not to trade. Bounded here as well as at the source — a public endpoint
    // must not grow without limit because an agent got chatty.
    const a = body.account && typeof body.account === "object" ? body.account : null;
    const trade = (t) => ({
      symbol: str(t.symbol, 20), side: t.side === "short" ? "short" : "long",
      entry: num(t.entry), exit: num(t.exit), stop: num(t.stop), target: num(t.target),
      stake: num(t.stake), riskAmt: num(t.riskAmt), pnl: num(t.pnl), R: num(t.R),
      reason: str(t.reason, 24), openedAt: num(t.openedAt), closedAt: num(t.closedAt),
    });
    const account = a ? {
      budget: num(a.budget), equity: num(a.equity), returnPct: num(a.returnPct),
      n: num(a.n), wins: num(a.wins), winRate: num(a.winRate),
      avgR: num(a.avgR), tStat: num(a.tStat), maxDrawdownPct: num(a.maxDrawdownPct),
      startedAt: num(a.startedAt),
      open: Array.isArray(a.open) ? a.open.slice(0, 12).map(trade) : [],
      closed: Array.isArray(a.closed) ? a.closed.slice(-60).map(trade) : [],
      journal: Array.isArray(a.journal) ? a.journal.slice(-80).map((j) => ({
        at: num(j.at), symbol: str(j.symbol, 20),
        action: str(j.action, 24), detail: str(j.detail, 240),
      })) : [],
    } : null;

    try {
      await db.prepare(
        "INSERT INTO argus_kv (key, data, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
      ).bind(KEY, JSON.stringify({
        forecasts, scoreboard, account, scoredCount: num(body.scoredCount), updatedAt: Date.now(),
      }), Date.now()).run();
    } catch { return json({ error: "db_write_failed" }, 503); }

    return json({ ok: true, saved: forecasts.length });
  }

  return json({ error: "method_not_allowed" }, 405);
}
