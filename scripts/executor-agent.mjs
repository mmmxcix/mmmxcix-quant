// executor-agent.mjs — the NATIVE backtest runner on your PC. Polls the site's
// job queue (/api/backtest-jobs), runs each strategy in its real language
// (C++ / q / native Python / JS) via nativeRun, and pushes the result back — so
// the browser (which can't run C++/q) gets a native, toolchain-real backtest.
//
// Persistent: started once by the agent-daemon and left running. Env:
//   LAB_TOKEN (req), LAB_SITE (default quant.mmmxcix.com), LAB_EXECUTOR_POLL_MS.
// Install g++ for C++ and a q binary for kdb+/q; missing tools are reported in
// the heartbeat and jobs needing them fail cleanly with "install X".

import os from "node:os";
import { nativeBacktest, detectTools } from "./nativeRun.mjs";
import { loadMarket } from "./marketdata.mjs";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
if (!TOKEN) { console.error("LAB_TOKEN is not set."); process.exit(1); }
const POLL_MS = +(process.env.LAB_EXECUTOR_POLL_MS || 4000);
const HB_MS = 60_000;

const post = (body) => fetch(`${SITE}/api/backtest-jobs`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: TOKEN, ...body }),
});

async function heartbeat() {
  try { await post({ ping: { tools: detectTools(), host: os.hostname() } }); } catch { /* offline */ }
}

async function claim() {
  try {
    const r = await fetch(`${SITE}/api/backtest-jobs?claim=1`, { headers: { "x-lab-token": TOKEN } });
    if (!r.ok) return null;
    return (await r.json()).job || null;
  } catch { return null; }
}

async function runJob(job) {
  const s = job.spec || {};
  let candles = Array.isArray(s.candles) ? s.candles : null;
  if (!candles && s.symbol) {
    const asset = s.market === "crypto" ? "crypto" : "stock";
    // loadMarket returns { name, market, candles } — pull the array out.
    const md = await loadMarket({ id: s.symbol, asset, symbol: s.symbol, interval: s.interval || "1d", bars: s.bars || 6000, range: s.range || "5y" }).catch(() => null);
    candles = md?.candles || null;
  }
  if (!candles?.length) return { id: job.id, ok: false, error: "no market data for that symbol/interval" };
  const res = await nativeBacktest({
    code: s.code, language: s.language, candles,
    capital: s.capital ?? 10000, feeBps: s.feeBps ?? 10, positionPct: s.positionPct ?? 100, leverage: s.leverage ?? 1,
  });
  if (res.ok) {
    // Trim heavy arrays so the pushed result stays small.
    const eq = res.equity || [];
    const stride = Math.max(1, Math.ceil(eq.length / 300));
    res.equity = eq.filter((_, i) => i % stride === 0);
    res.trades = (res.trades || []).slice(-120);
    res.language = s.language; res.symbol = s.symbol; res.interval = s.interval;
    res.ranAt = Date.now(); res.host = os.hostname();
  }
  return { id: job.id, ...res };
}

console.log(`[${new Date().toISOString()}] executor up — tools ${JSON.stringify(detectTools())} · ${SITE} · poll ${POLL_MS / 1000}s`);
await heartbeat();
let lastHb = Date.now();

// Main loop: claim → run → push, else idle. Heartbeat every minute.
for (;;) {
  const job = await claim();
  if (job) {
    console.log(`[${new Date().toISOString()}] job ${job.id}: ${job.spec?.language} ${job.spec?.symbol || ""} ${job.spec?.interval || ""}`);
    let result;
    try { result = await runJob(job); }
    catch (e) { result = { id: job.id, ok: false, error: String(e?.message || e).slice(0, 250) }; }
    try { await post({ result }); } catch { /* will be retried by the browser resubmitting */ }
    console.log(`  → ${result.ok ? `done (ret ${result.metrics?.totalReturnPct?.toFixed?.(1)}%)` : `fail: ${result.error || "install " + result.toolMissing}`}`);
  } else {
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (Date.now() - lastHb > HB_MS) { await heartbeat(); lastHb = Date.now(); }
}
