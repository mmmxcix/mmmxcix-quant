import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

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

export default defineConfig({
  plugins: [react()],
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
