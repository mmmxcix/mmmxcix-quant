// /api/board — the one retrieval surface over everything the tool knows.
//
// Three layers, and the split is the point: the catalog
// (src/lib/board/catalog.js) is pure and declares WHAT is answerable;
// functions/_lib/board.mjs does the fetching and the gating; this file is only
// the HTTP shape. /api/ask reuses the middle layer, so the chat runs exactly the
// reads this page does — one fetch path, one set of units, one failure mode.
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
import { makeLoader, runRead } from "../_lib/board.mjs";
import { listResources } from "../../src/lib/board/catalog.js";

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
  const load = makeLoader({ env, origin, request });

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
