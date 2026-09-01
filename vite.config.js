import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { existsSync, readFileSync } from "fs";
import { trimForApi } from "./functions/_lib/bvol.mjs";
import { compactOverview, validateOverviewSnapshot, cleanMeta } from "./functions/_lib/binanceOptions.mjs";
import { fetchOptionsOverview, clearBinanceOptionsCache } from "./src/lib/binanceOptions.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Yahoo's crumb-protected endpoints (options v7, quoteSummary v10) need a
// cookie + crumb pair. The production proxy (functions/api/yahoo) does this
// handshake at the edge; in dev we do it once at server start so those
// endpoints work under `vite dev` too. Best-effort: if it fails, the plain
// proxy still serves chart/search/timeseries.
async function yahooSession() {
  try {
    const r1 = await fetch("https://fc.yahoo.com/", {
      headers: { "user-agent": UA },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    const setCookies = typeof r1.headers.getSetCookie === "function"
      ? r1.headers.getSetCookie()
      : [r1.headers.get("set-cookie")].filter(Boolean);
    const cookie = setCookies.map((sc) => sc.split(";")[0]).filter(Boolean).join("; ");
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "user-agent": UA, cookie, accept: "text/plain" },
      signal: AbortSignal.timeout(5000),
    });
    const crumb = (await r2.text()).trim();
    if (cookie && crumb && !crumb.includes("<")) return { cookie, crumb };
  } catch { /* offline or blocked — crumb endpoints will 401 in dev */ }
  return { cookie: "", crumb: "" };
}

const session = await yahooSession();
const NEEDS_CRUMB = /^\/(v7\/finance\/options|v10\/finance\/quoteSummary)\//;

// Dev stand-in for the Pages Function /api/bvol (the BVOL history behind the
// Volatility tab's crypto view). In production it reads D1; here it serves the
// local backfill output (data/bvol/<SYMBOL>.json from scripts/bvol-backfill.mjs)
// with the same response shape, so the chart can be seen under `vite dev`.
// Without the files it answers `not_synced` exactly like the real endpoint.
function bvolDevApi() {
  return {
    name: "bvol-dev-api",
    configureServer(server) {
      server.middlewares.use("/api/bvol", (req, res) => {
        const symbol = (new URL(req.url, "http://localhost").searchParams.get("symbol") || "").replace(/[^A-Z]/g, "");
        const file = path.resolve(__dirname, "data", "bvol", `${symbol}.json`);
        res.setHeader("content-type", "application/json");
        if (!symbol || !existsSync(file)) { res.statusCode = 503; res.end(JSON.stringify({ ok: false, error: "not_synced" })); return; }
        try {
          const s = JSON.parse(readFileSync(file, "utf8"));
          res.end(JSON.stringify({ ok: true, symbol, at: s.at, stale: false, ...trimForApi(s) }));
        } catch (e) {
          res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: "bad_file", detail: String(e.message) }));
        }
      });
    },
  };
}

// Dev stand-in for the Pages Function /api/binance-options. In production the
// snapshot is PUSHED by scripts/binance-options-relay.mjs from the PC (Binance's
// options host is unreachable from Cloudflare and from browsers); here the same
// Node fetchers run inside the dev server, so `npm run dev` shows live data
// with no relay running. Same response shape as the function, cached 60 s.
// POST is accepted too (any token, in-memory) so the relay's push path can be
// exercised against localhost; a pushed snapshot is served until it is older
// than the computed one.
function binanceOptionsDevApi() {
  let computed = null; // { at, overview, meta }
  let pushed = null;
  const reply = (res, status, body) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  return {
    name: "binance-options-dev-api",
    configureServer(server) {
      server.middlewares.use("/api/binance-options", async (req, res) => {
        if (req.method === "POST") {
          let raw = "";
          req.on("data", (c) => { raw += c; });
          req.on("end", () => {
            let body;
            try { body = JSON.parse(raw); } catch { return reply(res, 400, { ok: false, error: "bad_json" }); }
            const v = validateOverviewSnapshot(body?.overview);
            if (!v.ok) return reply(res, 400, { ok: false, error: v.error });
            pushed = { at: Date.now(), overview: v.overview, meta: cleanMeta(body.meta) };
            reply(res, 200, { ok: true, stored: v.overview.length, at: pushed.at, dev: true });
          });
          return;
        }
        if (req.method !== "GET") return reply(res, 405, { ok: false, error: "method" });
        try {
          if (!computed || Date.now() - computed.at > 60_000) {
            clearBinanceOptionsCache();
            const c = compactOverview(await fetchOptionsOverview());
            computed = { at: c.at, overview: c.overview, meta: c.meta };
          }
          const snap = pushed && pushed.at >= computed.at ? pushed : computed;
          reply(res, 200, { ok: true, at: snap.at, ageMin: Math.max(0, Math.round((Date.now() - snap.at) / 60_000)), overview: snap.overview, meta: snap.meta });
        } catch (e) {
          reply(res, 502, { ok: false, error: "upstream", detail: String(e.message || e).slice(0, 160) });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), bvolDevApi(), binanceOptionsDevApi()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    // Mirrors the Cloudflare Pages Function /api/yahoo/* in local dev, so
    // stock charts work under `vite dev` too (Yahoo blocks browser CORS).
    proxy: {
      "/api/yahoo": {
        target: "https://query1.finance.yahoo.com",
        changeOrigin: true,
        headers: session.cookie ? { cookie: session.cookie, "user-agent": UA } : { "user-agent": UA },
        rewrite: (p) => {
          let out = p.replace(/^\/api\/yahoo/, "");
          if (session.crumb && NEEDS_CRUMB.test(out)) {
            out += (out.includes("?") ? "&" : "?") + "crumb=" + encodeURIComponent(session.crumb);
          }
          return out;
        },
      },
    },
  },
});
