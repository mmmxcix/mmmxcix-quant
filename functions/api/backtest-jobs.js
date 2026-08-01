// /api/backtest-jobs — a tiny job queue so the site can ask your PC to run a
// backtest in its REAL language (C++/q/native Python/JS) and get the result back.
// The site can't run C++/q itself (no toolchain in Workers), so the browser
// submits a job here, the executor-agent on your PC claims + runs it, and pushes
// the result back. Everything is dev-only.
//
//   POST { submit }            (admin)     → queue a job, returns { id }
//   GET  ?id=<id>              (admin)     → poll one job (status + result)
//   GET  ?status=1             (admin)     → executor heartbeat + pending count
//   GET  ?claim=1              (executor)  → claim the oldest pending job
//   POST { result:{id,...} }   (executor)  → store a job's result
//   POST { ping:{tools} }      (executor)  → executor heartbeat
//
// Backed by D1 (table backtest_jobs) + the argus_kv row 'backtest:executor'.

import { isAdminRequest } from "../_lib/auth.mjs";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a)), bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let d = 0; for (let i = 0; i < ab.length; i++) d |= ab[i] ^ bb[i];
  return d === 0;
}
const tokenOk = (env, request, body) => !!env.DEV_ACCESS_TOKEN && safeEqual(request.headers.get("x-lab-token") || body?.token || "", env.DEV_ACCESS_TOKEN);
const MAX_SPEC = 200 * 1024, MAX_RESULT = 512 * 1024;

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: "db_not_bound" }, 503);
  const url = new URL(request.url);

  if (request.method === "GET") {
    // Executor claims the oldest pending job (token-gated).
    if (url.searchParams.get("claim")) {
      if (!tokenOk(env, request, null)) return json({ error: "unauthorized" }, 401);
      const row = await db.prepare("SELECT id, spec FROM backtest_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1").first();
      if (!row) return json({ ok: true, job: null });
      const upd = await db.prepare("UPDATE backtest_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'").bind(Date.now(), row.id).run();
      if (!upd.meta?.changes) return json({ ok: true, job: null }); // someone else claimed it
      return json({ ok: true, job: { id: row.id, spec: JSON.parse(row.spec) } });
    }
    // Everything else here is admin-only.
    if (!(await isAdminRequest(env, request)) && !tokenOk(env, request, null)) return json({ error: "unauthorized" }, 401);
    if (url.searchParams.get("status")) {
      const exec = await db.prepare("SELECT data, updated_at FROM argus_kv WHERE key = 'backtest:executor'").first();
      const pending = await db.prepare("SELECT COUNT(*) AS n FROM backtest_jobs WHERE status IN ('pending','running')").first();
      const heartbeat = exec ? { ...JSON.parse(exec.data), at: exec.updated_at } : null;
      return json({ ok: true, executor: heartbeat, pending: pending?.n || 0 });
    }
    const id = url.searchParams.get("id");
    if (id) {
      const row = await db.prepare("SELECT id, status, result, created_at, updated_at FROM backtest_jobs WHERE id = ?").bind(id).first();
      if (!row) return json({ ok: true, job: null });
      return json({ ok: true, job: { id: row.id, status: row.status, result: row.result ? JSON.parse(row.result) : null, createdAt: row.created_at, updatedAt: row.updated_at } });
    }
    return json({ error: "bad_request" }, 400);
  }

  if (request.method === "POST") {
    let body; try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

    // Executor pushes a job result.
    if (body.result?.id) {
      if (!tokenOk(env, request, body)) return json({ error: "unauthorized" }, 401);
      const payload = JSON.stringify(body.result).slice(0, MAX_RESULT);
      await db.prepare("UPDATE backtest_jobs SET status = ?, result = ?, updated_at = ? WHERE id = ?")
        .bind(body.result.ok ? "done" : "error", payload, Date.now(), String(body.result.id)).run();
      return json({ ok: true });
    }
    // Executor heartbeat.
    if (body.ping) {
      if (!tokenOk(env, request, body)) return json({ error: "unauthorized" }, 401);
      await db.prepare("INSERT INTO argus_kv (key, data, updated_at) VALUES ('backtest:executor', ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
        .bind(JSON.stringify({ tools: body.ping.tools || {}, host: String(body.ping.host || "").slice(0, 60) }), Date.now()).run();
      return json({ ok: true });
    }
    // Browser submits a job (admin).
    if (body.submit) {
      if (!(await isAdminRequest(env, request)) && !tokenOk(env, request, body)) return json({ error: "unauthorized" }, 401);
      const spec = JSON.stringify(body.submit);
      if (spec.length > MAX_SPEC) return json({ error: "spec_too_large" }, 413);
      const id = `bt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const now = Date.now();
      await db.prepare("INSERT INTO backtest_jobs (id, status, spec, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?)").bind(id, spec, now, now).run();
      // Keep the table small — drop old finished jobs beyond the newest 60.
      await db.prepare("DELETE FROM backtest_jobs WHERE id NOT IN (SELECT id FROM backtest_jobs ORDER BY created_at DESC LIMIT 60)").run();
      return json({ ok: true, id });
    }
    return json({ error: "bad_request" }, 400);
  }

  return json({ error: "method_not_allowed" }, 405);
}
