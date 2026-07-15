// lab-agent.mjs — starter agent for the local 24/7 lab (Threepio phase 3).
// Runs on YOUR PC (invoked by n8n on a schedule, or manually for testing),
// does its computation locally, and pushes the resulting state to the site:
//
//   node scripts/lab-agent.mjs
//
// Requires the dev token in an environment variable (never hardcode it):
//   PowerShell:  $env:LAB_TOKEN = "…"; node scripts/lab-agent.mjs
//   n8n:         set LAB_TOKEN in the Execute Command node's env, or globally.
//
// This starter version just proves the loop end-to-end: it fetches live
// prices, computes a tiny heartbeat state, and pushes it. The real research /
// paper-trading logic grows inside `computeState()` over the next phases.

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;

if (!TOKEN) {
  console.error("LAB_TOKEN is not set. PowerShell: $env:LAB_TOKEN = \"<dev token>\"");
  process.exit(1);
}

async function computeState() {
  // Placeholder computation — replace/extend with real strategy evaluation.
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const prices = {};
  for (const s of symbols) {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${s}`);
    if (r.ok) prices[s] = +(await r.json()).price;
  }
  return {
    agent: "lab-agent v0.1",
    mode: "heartbeat", // later: "paper" once strategies run here
    lastRunAt: Date.now(),
    prices,
    strategies: [], // phase 2/3: [{ id, status, equity, lastSignal, … }]
    note: "starter agent online — the loop works",
  };
}

const state = await computeState();
const res = await fetch(`${SITE}/api/lab`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: TOKEN, state }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok || !out.ok) {
  console.error(`push failed: HTTP ${res.status}`, out);
  process.exit(1);
}
console.log(`state pushed (${out.bytes} bytes) →`, `${SITE}/api/lab`);
