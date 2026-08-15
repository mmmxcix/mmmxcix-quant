// /api/statements — what important people said, and which basket it points at.
//
// GET is public: the sources are public Telegram previews and public RSS, and
// the visibility rule from docs/BOARD.md is that a resource may be public only
// when its source already is.
//
// POST is machine-token gated. The ingest runs on the PC because the theme
// extraction goes through the local OmniRoute router (LAB_LLM_URL) — the site's
// own provider chain is a public-endpoint fallback and a per-statement LLM call
// on every page load is not something a free tier survives.
//
//   GET  /api/statements?days=30&limit=100[&theme=nuclear][&speaker=trump]
//   GET  /api/statements?what=themes    the catalog: id, name, mechanism, basket
//   GET  /api/statements?what=stats
//   POST { token, statements: [...] }
//
// WHAT THIS ENDPOINT DOES NOT SERVE, deliberately: any number describing what a
// basket did after a statement. The measurement lives in
// docs/STATEMENTS_FINDINGS.md, and until a theme survives the shifted-date
// placebo there is nothing here that would let a page imply the chain pays.
// Every row carries the theme it was matched to and the mechanism behind that
// theme — a claim about WHO would benefit, which is checkable — and no claim
// about whether they did.

import { clampInt, putStatements, readStatements, readStats, SPEAKER_ID, THEME_ID } from "../_lib/statements.mjs";
import { THEMES } from "../../src/lib/statements/themes.js";

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
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

const MAX_BATCH = 500;

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: "db_not_bound" }, 503);

  if (request.method === "GET") {
    const url = new URL(request.url);
    const what = url.searchParams.get("what") || "statements";

    // The theme catalog is static and safe to cache — it is the same list the
    // study measured, served so a client never has to hard-code it.
    if (what === "themes") {
      return json({
        ok: true,
        themes: THEMES.map((t) => ({ id: t.id, name: t.name, why: t.why, basket: t.basket })),
        note: "Baskets are fixed lists chosen for the MECHANISM, not a ranking. No performance claim attaches to them — see docs/STATEMENTS_FINDINGS.md.",
      }, 200, 3600);
    }

    if (what === "stats") return json({ ok: true, stats: await readStats(db) });

    if (what === "statements") {
      const theme = (url.searchParams.get("theme") || "").trim().toLowerCase();
      const speaker = (url.searchParams.get("speaker") || "").trim().toLowerCase();
      // Refuse rather than ignore: a filter that silently stops filtering
      // returns the whole table and looks like a much bigger answer.
      if (theme && !THEME_ID.test(theme)) return json({ error: "bad_theme" }, 400);
      if (speaker && !SPEAKER_ID.test(speaker)) return json({ error: "bad_speaker" }, 400);
      const rows = await readStatements(db, {
        days: clampInt(url.searchParams.get("days"), 1, 3650, 30),
        limit: clampInt(url.searchParams.get("limit"), 1, 500, 100),
        theme: theme || null,
        speaker: speaker || null,
      });
      return json({ ok: true, statements: rows });
    }

    // Deny by default — /api/argus taught this the expensive way.
    return json({ error: "bad_what" }, 400);
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    if (!env.DEV_ACCESS_TOKEN || !safeEqual(body.token || "", env.DEV_ACCESS_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (!Array.isArray(body.statements) || !body.statements.length) return json({ error: "empty" }, 400);
    try {
      const n = await putStatements(db, body.statements.slice(0, MAX_BATCH));
      return json({ ok: true, statements: n });
    } catch (e) {
      return json({ error: "db_write_failed", detail: String(e?.message || e).slice(0, 120) }, 503);
    }
  }

  return json({ error: "method" }, 405);
}
