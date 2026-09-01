// binance-options-relay.mjs — read the Binance options chain HERE and push a
// compact overview snapshot to the site.
//
//   node scripts/binance-options-relay.mjs                 # one push, then exit
//   node scripts/binance-options-relay.mjs --loop          # every 15 min, forever
//   node scripts/binance-options-relay.mjs --loop 300      # every 5 min
//   node scripts/binance-options-relay.mjs --api http://localhost:5199   # against the dev server
//
// WHY THIS RUNS ON THE PC. Binance's options host (eapi.binance.com) sends no
// CORS headers, so the browser can't read it, and it answers every request from
// Cloudflare Workers with a CloudFront 403, so a Pages-Function proxy can't
// either (both measured 2026-09-01). This machine reaches it fine. So the chain
// is summarised here — src/lib/binanceOptions.js builds ATM IV term structures,
// 25-delta skews, put/call ratios and open interest per underlying — and the
// SUMMARY (not the 1,946 contracts; ~10 KB) is POSTed to /api/binance-options,
// which stores it in D1 and serves it to the Volatility tab. Same arrangement
// as the AIS relay and the DoltHub IV snapshot.
//
// Auth: DEV_ACCESS_TOKEN or LAB_TOKEN from the environment (the token is never
// printed). A refused push exits 2 so a scheduler can see it; a transient
// failure in --loop mode is logged and retried on the next tick.

import { fetchOptionsOverview, clearBinanceOptionsCache } from "../src/lib/binanceOptions.js";
import { compactOverview } from "../functions/_lib/binanceOptions.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[a.slice(2)] = next; i++; } else args[a.slice(2)] = true;
}
const API = String(args.api || "https://quant.mmmxcix.com").replace(/\/$/, "");
const LOOP_SEC = args.loop == null ? 0 : args.loop === true ? 900 : Math.max(30, Number(args.loop) || 900);
const TOKEN = process.env.DEV_ACCESS_TOKEN || process.env.LAB_TOKEN || "";

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN) {
  console.error(`[${stamp()}] no DEV_ACCESS_TOKEN / LAB_TOKEN in the environment — nothing to push with`);
  process.exit(2);
}

/** @returns {boolean} pushed */
async function pushOnce() {
  const t0 = Date.now();
  clearBinanceOptionsCache(); // a loop tick must read the market, not last tick's memo
  const ov = await fetchOptionsOverview();
  const snap = compactOverview(ov);
  const body = JSON.stringify({ token: TOKEN, overview: snap.overview, meta: snap.meta });
  const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
  const built = Date.now() - t0;

  const res = await fetch(`${API}/api/binance-options`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
    signal: AbortSignal.timeout(30_000),
  });
  const out = await res.json().catch(() => ({}));
  const names = snap.overview.map((r) => r.base).join(",");
  const oi = snap.meta.oiFailed ? ` (OI ${snap.meta.oiFailed}/${snap.meta.oiRequested} failed)` : "";
  console.log(`[${stamp()}] ${res.ok ? "pushed" : "REFUSED"} ${snap.overview.length} underlyings [${names}] ${kb} KB, built in ${built} ms${oi} → HTTP ${res.status} ${JSON.stringify(out).slice(0, 120)}`);
  if (res.status === 401 || res.status === 403) {
    console.error(`[${stamp()}] the site refused the token — DEV_ACCESS_TOKEN/LAB_TOKEN here does not match the one on Pages`);
    process.exit(2);
  }
  return res.ok;
}

if (!LOOP_SEC) {
  try {
    process.exit((await pushOnce()) ? 0 : 1);
  } catch (e) {
    console.error(`[${stamp()}] push failed: ${String(e.message || e).slice(0, 160)}`);
    process.exit(1);
  }
}

console.log(`[${stamp()}] relay loop: every ${LOOP_SEC}s → ${API}`);
for (;;) {
  try { await pushOnce(); }
  catch (e) { console.error(`[${stamp()}] tick failed: ${String(e.message || e).slice(0, 160)}`); }
  await sleep(LOOP_SEC * 1000);
}
