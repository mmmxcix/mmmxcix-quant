import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { existsSync, readFileSync } from "fs";
import { trimForApi } from "./functions/_lib/bvol.mjs";

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

export default defineConfig({
  plugins: [react(), bvolDevApi()],
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
      // Mirrors functions/api/binance-options/[[path]].js: Binance's OPTIONS host
      // (eapi) sends no CORS headers, unlike spot/futures, so it needs a proxy.
      "/api/binance-options": {
        target: "https://eapi.binance.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/binance-options/, "/eapi/v1"),
      },
    },
  },
});
