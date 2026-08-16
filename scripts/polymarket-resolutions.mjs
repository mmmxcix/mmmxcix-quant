// polymarket-resolutions.mjs — the true terminal value of an open position.
//
// Two fetches, both resumable, both keyless.
//
//   A) ConditionResolution logs from the Gnosis Conditional Tokens contract on
//      Polygon. `eth_getLogs` is capped at 10,000 blocks per call by the public
//      RPCs (measured, not assumed), so the range is walked in chunks and
//      checkpointed. Two endpoints in rotation, a few workers, because 56M
//      blocks is 5,600 calls.
//
//   B) token id → { condition, outcomeIndex } from the orderbook subgraph's
//      MarketData entity. This is the link that makes A usable at all: a
//      position id cannot be inverted back to its condition — the derivation
//      runs forwards through an elliptic-curve point — so without this table the
//      resolutions on chain and the positions in the ledger never meet.
//
//   node scripts/polymarket-resolutions.mjs            # both phases
//   node scripts/polymarket-resolutions.mjs --phase tokens
//
// Writes data/polymarket/{resolutions.json, tokenmap.json} — gitignored.

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CTF_ADDRESS, CONDITION_RESOLUTION_TOPIC, decodeResolution } from "../src/lib/polymarket/resolve.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "data", "polymarket");
const WDIR = join(DIR, "wallets");

// MEASURED 16 Aug 2026, and the reason this phase needs a key you do not yet
// have: no free public Polygon endpoint will serve historical logs.
//   publicnode  — history PRUNED; only near-head ranges answer
//   drpc        — refuses eth_getLogs with any range on the free plan
//   1rpc        — caps at 50 blocks
//   ankr, blast — require a key
//   llamarpc    — empty responses
// The sibling subgraphs do not help either: oi-subgraph and fpmm-subgraph are
// alive but their Condition entity carries only `id`, no payouts.
// Set PM_RPC to any archive endpoint (Alchemy, Infura and QuickNode all include
// Polygon archive in their free tier) and this phase runs as written.
const RPCS = (process.env.PM_RPC || "https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org")
  .split(",").map((u) => u.trim()).filter(Boolean);
const GS = "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/prod/gn";

// Every provider caps eth_getLogs differently — 10,000 blocks on Infura, a
// response-size limit on Alchemy, 50 on 1rpc — and the cap is not always stated
// in the error. So the chunk size ADAPTS: it starts here and halves whenever a
// provider complains about the range, down to a floor. Nobody has to look up
// their plan's limit before running this.
const CHUNK = +(process.env.PM_CHUNK || 10_000);
const MIN_CHUNK = 200;
const RANGE_ERROR = /range|too many|limited to|exceeds|larger than|block range|response size|query returned more/i;
const WORKERS = 4;
const START_BLOCK = +(process.env.PM_START_BLOCK || 35_000_000);  // ≈ Nov 2022, before the first fill
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

let rpcTurn = 0;
async function rpc(method, params, tries = 4) {
  for (let a = 0; a < tries; a++) {
    const url = RPCS[rpcTurn++ % RPCS.length];
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!r.ok) { await sleep(600 * (a + 1)); continue; }
      const j = await r.json();
      // An RPC error is not an empty range. Returning [] on a rate limit would
      // silently record "no market resolved in these blocks".
      if (j.error) {
        if (RANGE_ERROR.test(String(j.error.message || ""))) return { __rangeTooBig: String(j.error.message).slice(0, 80) };
        await sleep(800 * (a + 1));
        continue;
      }
      return j.result;
    } catch { await sleep(900 * (a + 1)); }
  }
  return null;
}

/** eth_getLogs over a range, halving the window whenever the provider objects. */
async function getLogsAdaptive(from, to, state) {
  let size = state.chunk;
  let cursor = from;
  const out = [];
  while (cursor <= to) {
    const end = Math.min(cursor + size - 1, to);
    const res = await rpc("eth_getLogs", [{
      address: CTF_ADDRESS,
      topics: [CONDITION_RESOLUTION_TOPIC],
      fromBlock: "0x" + cursor.toString(16),
      toBlock: "0x" + end.toString(16),
    }]);
    if (res && res.__rangeTooBig) {
      if (size <= MIN_CHUNK) return null;          // even the floor is refused
      size = Math.max(MIN_CHUNK, Math.floor(size / 2));
      if (size < state.chunk) {
        state.chunk = size;
        console.log(`  window narrowed to ${size} blocks (${res.__rangeTooBig})`);
      }
      continue;
    }
    if (res === null) return null;
    out.push(...res);
    cursor = end + 1;
  }
  return out;
}

// ── phase A: every resolution ───────────────────────────────────────────────

async function scanResolutions() {
  const path = join(DIR, "resolutions.json");
  let state = { conditions: {}, scannedTo: START_BLOCK, blockTimes: {} };
  if (existsSync(path)) {
    try { state = JSON.parse(readFileSync(path, "utf8")); } catch { /* start over */ }
  }
  const headHex = await rpc("eth_blockNumber", []);
  if (!headHex) throw new Error("no RPC reachable");
  const head = parseInt(headHex, 16);
  console.log(`resolutions: scanning ${state.scannedTo} → ${head} (${Math.ceil((head - state.scannedTo) / CHUNK)} chunks of ${CHUNK})`);

  // Chunks are handed out in order but completed out of order, so the resume
  // point only advances past a PREFIX of finished chunks — a checkpoint that
  // jumped to the furthest finished chunk would silently skip the gaps.
  const chunks = [];
  for (let from = state.scannedTo; from <= head; from += CHUNK) {
    chunks.push([from, Math.min(from + CHUNK - 1, head)]);
  }
  const done = new Array(chunks.length).fill(false);
  const sizing = { chunk: CHUNK };   // shared, so one worker's discovery helps all
  let next = 0, finished = 0, found = 0, failed = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= chunks.length) return;
      const [from, to] = chunks[i];
      const logs = await getLogsAdaptive(from, to, sizing);
      if (logs === null) { failed++; done[i] = false; }
      else {
        for (const log of logs) {
          const r = decodeResolution(log);
          if (!r) continue;
          state.conditions[r.conditionId] = { p: r.payouts, t: r.total, b: r.blockNumber };
          found++;
        }
        done[i] = true;
      }
      finished++;
      if (finished % 200 === 0) {
        console.log(`resolutions: ${finished}/${chunks.length} chunks, ${found} resolutions, ${failed} chunks unread`);
        checkpoint(path, state, chunks, done);
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  checkpoint(path, state, chunks, done);
  console.log(`resolutions: ${Object.keys(state.conditions).length} conditions on disk, ${failed} chunks unread (rerun to fill them)`);
  return state;
}

function checkpoint(path, state, chunks, done) {
  let prefix = 0;
  while (prefix < done.length && done[prefix]) prefix++;
  state.scannedTo = prefix > 0 ? chunks[prefix - 1][1] + 1 : state.scannedTo;
  writeFileSync(path, JSON.stringify(state));
}

// ── phase B: token id → condition ───────────────────────────────────────────

/** Every token any harvested wallet ever touched. */
function tokensInLedger() {
  const set = new Set();
  for (const f of readdirSync(WDIR).filter((x) => /^0x[0-9a-f]{40}\.json$/.test(x))) {
    const w = JSON.parse(readFileSync(join(WDIR, f), "utf8"));
    for (const t of w.trades || []) set.add(t[1]);
  }
  return [...set];
}

async function mapTokens() {
  const path = join(DIR, "tokenmap.json");
  let map = {};
  if (existsSync(path)) { try { map = JSON.parse(readFileSync(path, "utf8")); } catch { map = {}; } }
  const todo = tokensInLedger().filter((t) => !(t in map));
  console.log(`tokenmap: ${Object.keys(map).length} known, ${todo.length} to look up`);

  // `id_in` rather than one aliased sub-query per token. The first version asked
  // 50 at a time and was on course for two hours; the filter takes hundreds in a
  // single request and finishes in minutes. Same answer, three orders of
  // magnitude less waiting.
  const BATCH = 500;
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const query = `{ marketDatas(first:${BATCH}, where:{id_in:${JSON.stringify(slice)}}){ id condition outcomeIndex } }`;
    let rows = null;
    for (let a = 0; a < 3 && rows === null; a++) {
      try {
        const r = await fetch(GS, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ query }), signal: AbortSignal.timeout(90_000),
        });
        const j = await r.json();
        if (!j.errors && j.data) rows = j.data.marketDatas || [];
      } catch { /* retry */ }
      if (rows === null) await sleep(1200 * (a + 1));
    }
    if (rows === null) continue;               // leave them unmapped; a rerun retries
    const got = new Map(rows.map((r) => [r.id, r]));
    for (const t of slice) {
      const row = got.get(t);
      // A token the subgraph has no row for is written as null rather than left
      // out, so a rerun does not keep asking the same unanswerable question.
      map[t] = row ? { condition: row.condition, outcomeIndex: Number(row.outcomeIndex) } : null;
    }
    if ((i / BATCH) % 20 === 0) {
      writeFileSync(path, JSON.stringify(map));
      console.log(`tokenmap: ${i + slice.length}/${todo.length}`);
    }
  }
  writeFileSync(path, JSON.stringify(map));
  const known = Object.values(map).filter(Boolean).length;
  console.log(`tokenmap: ${Object.keys(map).length} tokens, ${known} mapped to a condition`);
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const phase = arg("phase", "all");
  if (phase === "all" || phase === "tokens") await mapTokens();
  if (phase === "all" || phase === "resolutions") await scanResolutions();
}

main().catch((e) => { console.error(e); process.exit(1); });
