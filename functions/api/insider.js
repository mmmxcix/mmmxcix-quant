// /api/insider — SEC Form 4 insider transactions and the cluster buys in them.
//
// GET is PUBLIC. Everything served here is already a public SEC filing, and the
// visibility rule this project uses (see docs/BOARD.md) is that a resource is
// public only if its source already is — this one is, by federal law.
//
// POST is machine-token gated: scripts/insider-agent.mjs on the PC does the
// ingest, because SEC serves a 403 to a default HTTP client and expects a real
// User-Agent with a contact, and because the daily index is ~1,000 filings a day
// at 10 requests a second — a shape that belongs on a long-lived agent, not in a
// Worker with a CPU budget of milliseconds.
//
//   GET  /api/insider?what=clusters&days=90&limit=100[&symbol=XYZ]
//   GET  /api/insider?what=filings&days=7&limit=200[&symbol=XYZ][&purchases=1]
//   GET  /api/insider?what=stats
//   POST { token, filings: [...] }                    ingest normalized filings
//   POST { token, clusters: [...], clusterParams: {} } upsert derived clusters
//
// NOTE ON WHAT THIS ENDPOINT DOES NOT DO. It serves filings and clusters. It
// does not rank them, score them or call any of them a buy signal. Whether the
// cluster form predicts anything is measured in docs/INSIDER_FINDINGS.md, and
// until that answer is in the affirmative there is deliberately nothing here
// that would let a page imply otherwise.

import { clampInt, putClusters, putFilings, readClusters, readFilings, readStats, TICKER } from "../_lib/insider.mjs";

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

/** A ticker or nothing. An unparseable symbol is refused, never ignored — a
 *  filter that silently stops filtering returns the whole table instead. */
function symbolParam(url) {
  const raw = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!raw) return { ok: true, symbol: null };
  return TICKER.test(raw) ? { ok: true, symbol: raw } : { ok: false };
}

const MAX_BATCH = 2000;

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: "db_not_bound" }, 503);

  if (request.method === "GET") {
    const url = new URL(request.url);
    const what = url.searchParams.get("what") || "clusters";
    const sym = symbolParam(url);
    if (!sym.ok) return json({ error: "bad_symbol" }, 400);

    if (what === "stats") return json({ ok: true, stats: await readStats(db) });

    if (what === "clusters") {
      const rows = await readClusters(db, {
        days: clampInt(url.searchParams.get("days"), 1, 3650, 90),
        limit: clampInt(url.searchParams.get("limit"), 1, 500, 100),
        symbol: sym.symbol,
      });
      return json({ ok: true, clusters: rows.map((r) => ({ ...safeParse(r.data), id: r.id })) });
    }

    if (what === "filings") {
      const rows = await readFilings(db, {
        days: clampInt(url.searchParams.get("days"), 1, 3650, 7),
        limit: clampInt(url.searchParams.get("limit"), 1, 2000, 200),
        symbol: sym.symbol,
        purchasesOnly: url.searchParams.get("purchases") === "1",
      });
      return json({ ok: true, filings: rows.map((r) => safeParse(r.data)).filter(Boolean) });
    }

    // Deny by default. /api/argus taught this the expensive way: an open `what`
    // parameter is an authorization bypass waiting for someone to guess a key.
    return json({ error: "bad_what" }, 400);
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!env.DEV_ACCESS_TOKEN || !safeEqual(body.token || "", env.DEV_ACCESS_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    try {
      let filings = 0, clusters = 0;
      if (Array.isArray(body.filings) && body.filings.length) {
        filings = await putFilings(db, body.filings.slice(0, MAX_BATCH));
      }
      if (Array.isArray(body.clusters) && body.clusters.length) {
        clusters = await putClusters(db, body.clusters.slice(0, MAX_BATCH), body.clusterParams);
      }
      if (!filings && !clusters) return json({ error: "empty" }, 400);
      return json({ ok: true, filings, clusters });
    } catch (e) {
      return json({ error: "db_write_failed", detail: String(e?.message || e).slice(0, 120) }, 503);
    }
  }

  return json({ error: "method" }, 405);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
