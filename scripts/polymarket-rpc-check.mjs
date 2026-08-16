// polymarket-rpc-check.mjs — is this endpoint good enough for the scan?
//
// Three things have to be true, and each of the free public endpoints failed a
// different one, which is why this exists as its own check rather than being
// discovered halfway through a 5,700-chunk run:
//
//   1. it answers at all
//   2. it still HAS the history (publicnode has pruned it — the giveaway is
//      that a near-head query works and an old one does not)
//   3. it will serve eth_getLogs over a usable range (1rpc caps at 50 blocks;
//      drpc's free plan refuses ranges outright)
//
//   node scripts/polymarket-rpc-check.mjs <url>
//   PM_RPC=<url> node scripts/polymarket-rpc-check.mjs

import { CTF_ADDRESS, CONDITION_RESOLUTION_TOPIC, decodeResolution } from "../src/lib/polymarket/resolve.js";

const url = process.argv[2] || (process.env.PM_RPC || "").split(",")[0];
if (!url) { console.error("usage: node scripts/polymarket-rpc-check.mjs <archive-rpc-url>"); process.exit(1); }

async function call(method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) return { error: { message: `HTTP ${r.status}` } };
  return r.json();
}

const hex = (n) => "0x" + n.toString(16);

async function main() {
  console.log(`checking ${url.replace(/\/[^/]{12,}\/?$/, "/…")}\n`);

  const head = await call("eth_blockNumber", []);
  if (head.error || !head.result) { console.log(`✗ does not answer: ${head.error?.message || "no result"}`); process.exit(1); }
  const h = parseInt(head.result, 16);
  console.log(`✓ answers — head is block ${h.toLocaleString("en-US")}`);

  // The archive test. Block 40,000,000 is early 2023, comfortably inside the
  // window the study needs and comfortably outside a pruned node's retention.
  const old = await call("eth_getBlockByNumber", [hex(40_000_000), false]);
  if (old.error || !old.result) { console.log(`✗ NOT an archive node: ${old.error?.message || "block 40,000,000 unavailable"}`); process.exit(1); }
  console.log(`✓ has history — block 40,000,000 is dated ${new Date(parseInt(old.result.timestamp, 16) * 1000).toISOString().slice(0, 10)}`);

  // The range test, biggest first: whatever it accepts is what the scan will use.
  let best = 0, lastErr = "";
  for (const size of [10_000, 5_000, 2_000, 500, 200]) {
    const from = 74_000_000;
    const res = await call("eth_getLogs", [{
      address: CTF_ADDRESS,
      topics: [CONDITION_RESOLUTION_TOPIC],
      fromBlock: hex(from), toBlock: hex(from + size - 1),
    }]);
    if (res.error) { lastErr = res.error.message; continue; }
    best = size;
    const decoded = (res.result || []).map(decodeResolution).filter(Boolean);
    console.log(`✓ eth_getLogs over ${size.toLocaleString("en-US")} blocks — ${decoded.length} resolutions decoded`);
    if (decoded.length) {
      const r = decoded[0];
      console.log(`  sample: condition ${r.conditionId.slice(0, 14)}… payouts [${r.payouts.join(", ")}]`);
    }
    break;
  }
  if (!best) { console.log(`✗ will not serve log ranges: ${lastErr}`); process.exit(1); }

  const chunks = Math.ceil((h - 35_000_000) / best);
  console.log(`\nUSABLE. Full scan is ~${chunks.toLocaleString("en-US")} requests at ${best.toLocaleString("en-US")} blocks each.`);
  console.log(`\n  PM_RPC="${url}" node scripts/polymarket-resolutions.mjs --phase resolutions`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
