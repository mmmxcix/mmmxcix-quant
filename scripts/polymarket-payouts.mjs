// polymarket-payouts.mjs — the terminal value of every open position, read as
// contract STATE at the exact block the book is valued on.
//
// WHY NOT LOGS. The first design scanned `ConditionResolution` events. That is
// dead on any free plan: Alchemy caps a log range at TEN blocks (measured, and
// its own error says so), which is 5.7 million requests for this history;
// publicnode has pruned it; drpc refuses ranges outright.
//
// But a resolution is not only an event, it is also state. The Conditional
// Tokens contract exposes two public getters:
//
//   payoutDenominator(bytes32 conditionId)          → 0 while unresolved
//   payoutNumerators(bytes32 conditionId, uint i)   → outcome i's share
//
// `eth_call` has no range limit, archive `eth_call` works on the free tier, and
// JSON-RPC batching works — all three verified 17 Aug 2026. Selectors are
// derived with src/lib/polymarket/keccak.js, whose implementation is pinned
// against the ConditionResolution topic that was independently decoded off a
// real log, so they are computed rather than guessed.
//
// AND IT REMOVES THE FUTURE-LEAK BY CONSTRUCTION. Reading the state AT the
// valuation block cannot see a market that resolved later — `payoutDenominator`
// simply returns 0 there. The log-based design had to date each resolution and
// filter it out afterwards, which is the same answer reached by a route that can
// be got wrong.
//
//   node --env-file=.env scripts/polymarket-payouts.mjs
//
// Needs data/polymarket/tokenmap.json (scripts/polymarket-resolutions.mjs
// --phase tokens). Writes data/polymarket/payouts.json — gitignored.

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { selector } from "../src/lib/polymarket/keccak.js";
import { CTF_ADDRESS } from "../src/lib/polymarket/resolve.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "data", "polymarket");
const WDIR = join(DIR, "wallets");
const URL_RPC = (process.env.PM_RPC || "").split(",")[0].trim();
if (!URL_RPC) { console.error("PM_RPC is not set — see docs/TODO.md for how to get one."); process.exit(1); }

// Keep in step with SPLITS in scripts/polymarket-validate.mjs. `null` means the
// end of the fill data, resolved from the ledger below.
const EDGES = [
  Date.UTC(2025, 9, 1) / 1000, Date.UTC(2025, 10, 15) / 1000,
  Date.UTC(2026, 0, 1) / 1000, Date.UTC(2026, 1, 15) / 1000,
  null,
];

const SEL_DEN = selector("payoutDenominator(bytes32)");
const SEL_NUM = selector("payoutNumerators(bytes32,uint256)");
const pad = (h) => String(h).replace(/^0x/, "").padStart(64, "0");
const BATCH = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// THE TRAP THIS SCRIPT WALKED INTO ONCE. Alchemy does not answer an
// over-capacity batch with 429. It answers HTTP 200 and puts the refusal in the
// INDIVIDUAL calls: {"error":{"message":"Your app has exceeded its compute units
// per second capacity"}}. The first version treated a per-call error as "this
// condition is not resolved", so throttling was silently recorded as data — it
// reported 629 resolved conditions out of 28,586 and 0 valued tokens, and both
// numbers were the rate limiter. A throttled call is now retried until it
// answers, and anything still unanswered at the end is COUNTED and printed.
const THROTTLED = /compute units|rate limit|too many requests|capacity/i;

/**
 * Run many eth_calls, retrying whatever the provider throttled.
 *
 * @param {Array<{key:string,data:string}>} items
 * @returns {{results: Map<string,string>, unanswered: number}}
 */
async function callAll(items, blockTag, label) {
  const results = new Map();
  let queue = items.slice();
  let wait = 0, round = 0;
  while (queue.length && round < 60) {
    round++;
    const next = [];
    for (let k = 0; k < queue.length; k += BATCH) {
      const slice = queue.slice(k, k + BATCH);
      if (wait) await sleep(wait);
      const res = await rpcBatch(slice.map((it, n) => ({
        jsonrpc: "2.0", id: n, method: "eth_call",
        params: [{ to: CTF_ADDRESS, data: it.data }, blockTag],
      })));
      if (!res) { next.push(...slice); wait = Math.min(4000, (wait || 250) * 2); continue; }
      let throttled = 0;
      for (const r of res) {
        const it = slice[r.id];
        if (!it) continue;
        if (r.error) {
          if (THROTTLED.test(String(r.error.message || ""))) { next.push(it); throttled++; }
          continue;                                  // a genuine revert: leave it out
        }
        if (r.result) results.set(it.key, r.result);
      }
      // Converge on the provider's real sustained rate instead of guessing it.
      if (throttled > slice.length / 10) wait = Math.min(4000, (wait || 200) * 2);
      else if (wait > 0) wait = Math.max(0, Math.floor(wait * 0.8));
      if ((k / BATCH) % 40 === 0) {
        process.stdout.write(`\r  ${label}: ${results.size}/${items.length} answered, ${next.length} requeued, pace ${wait}ms   `);
      }
    }
    queue = next;
    if (queue.length) process.stdout.write(`\r  ${label}: retry round ${round} for ${queue.length} calls, pace ${wait}ms      `);
  }
  process.stdout.write("\n");
  return { results, unanswered: queue.length };
}

async function rpcBatch(calls) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(URL_RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(calls), signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) { await sleep(800 * (a + 1)); continue; }
      const j = await r.json();
      if (Array.isArray(j)) return j;
      await sleep(800 * (a + 1));
    } catch { await sleep(1000 * (a + 1)); }
  }
  return null;
}

async function rpc(method, params) {
  const out = await rpcBatch([{ jsonrpc: "2.0", id: 1, method, params }]);
  return out && !out[0].error ? out[0].result : null;
}

/** Exact block for a timestamp, by bisection. ~26 calls, and no drift. */
async function blockAt(ts, head) {
  let lo = 1, hi = head, best = head;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await rpc("eth_getBlockByNumber", ["0x" + mid.toString(16), false]);
    if (!b) return null;
    const bts = parseInt(b.timestamp, 16);
    if (bts <= ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/**
 * What each wallet was still holding at each edge.
 *
 * Net balance per token, walked in time order. Over-inclusive by design: a token
 * listed here that nobody really held costs one wasted state read, a token
 * missed costs a position that silently falls back to its last traded price.
 */
function openAtEdges(edges) {
  const perEdge = edges.map(() => new Set());
  for (const f of readdirSync(WDIR).filter((x) => /^0x[0-9a-f]{40}\.json$/.test(x))) {
    const w = JSON.parse(readFileSync(join(WDIR, f), "utf8"));
    const bal = new Map();
    let e = 0;
    for (const [ts, tok, isBuy, , tokens] of w.trades || []) {
      while (e < edges.length && ts >= edges[e]) {
        for (const [k, v] of bal) if (v > 1e-9) perEdge[e].add(k);
        e++;
      }
      bal.set(tok, (bal.get(tok) || 0) + (isBuy ? tokens : -tokens));
    }
    for (let k = e; k < edges.length; k++) {
      for (const [t, v] of bal) if (v > 1e-9) perEdge[k].add(t);
    }
  }
  return perEdge;
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const tmPath = join(DIR, "tokenmap.json");
  if (!existsSync(tmPath)) throw new Error("tokenmap.json missing — run scripts/polymarket-resolutions.mjs --phase tokens");
  const tokenMap = JSON.parse(readFileSync(tmPath, "utf8"));

  const headHex = await rpc("eth_blockNumber", []);
  if (!headHex) throw new Error("PM_RPC does not answer");
  const head = parseInt(headHex, 16);

  // The end of the fill data — the edge the out-of-sample book is valued on.
  let tEnd = 0;
  for (const f of readdirSync(WDIR).filter((x) => /^0x[0-9a-f]{40}\.json$/.test(x))) {
    const w = JSON.parse(readFileSync(join(WDIR, f), "utf8"));
    for (const t of w.trades || []) if (t[0] > tEnd) tEnd = t[0];
  }
  let edges = EDGES.map((e) => e ?? tEnd);
  // The out-of-sample book is the one whose LEVEL is the result; the in-sample
  // numbers are only a ranking key, where the ordering is what matters and a
  // last-price mark is defensible. On a free plan that is a four-hour job
  // against a one-hour one, so --edge last does the result first.
  if (process.argv.includes("--edge") && process.argv[process.argv.indexOf("--edge") + 1] === "last") edges = [tEnd];

  const out = existsSync(join(DIR, "payouts.json"))
    ? JSON.parse(readFileSync(join(DIR, "payouts.json"), "utf8"))
    : { builtAt: Date.now(), edges: {}, };

  const open = openAtEdges(edges);

  for (let i = 0; i < edges.length; i++) {
    const ts = edges[i];
    const key = String(ts);
    if (out.edges[key]?.done) { console.log(`edge ${new Date(ts * 1000).toISOString().slice(0, 10)}: cached`); continue; }

    const block = await blockAt(ts, head);
    console.log(`\nedge ${new Date(ts * 1000).toISOString().slice(0, 10)} → block ${block.toLocaleString("en-US")}, ${open[i].size} tokens open`);
    const blockTag = "0x" + block.toString(16);

    // Which conditions, and which outcome of each, are actually held here.
    const need = new Map();     // condition → Set(outcomeIndex)
    const tokenOf = new Map();  // `${condition}:${idx}` → [tokenId…]
    for (const tok of open[i]) {
      const m = tokenMap[tok];
      if (!m || !m.condition) continue;
      const c = String(m.condition).toLowerCase();
      if (!need.has(c)) need.set(c, new Set());
      need.get(c).add(m.outcomeIndex);
      const k = `${c}:${m.outcomeIndex}`;
      if (!tokenOf.has(k)) tokenOf.set(k, []);
      tokenOf.get(k).push(tok);
    }
    const conditions = [...need.keys()];
    console.log(`  ${conditions.length} distinct conditions to check`);

    // Pass 1: which of them had resolved BY this block. A zero denominator here
    // is the whole no-look-ahead guarantee — the state at this block simply does
    // not know about a market that resolved later.
    const denOut = await callAll(
      conditions.map((c) => ({ key: c, data: SEL_DEN + pad(c) })), blockTag, "denominators");
    const resolved = new Map();
    for (const [c, hex] of denOut.results) {
      const den = BigInt(hex);
      if (den > 0n) resolved.set(c, den);
    }
    console.log(`  ${resolved.size} of ${denOut.results.size} answered conditions had resolved by then` +
      (denOut.unanswered ? ` — ${denOut.unanswered} NEVER ANSWERED and are excluded, not assumed unresolved` : ""));

    // Pass 2: the numerator of the outcome each open token actually is.
    const wanted = [];
    for (const [c, den] of resolved) {
      for (const idx of need.get(c)) wanted.push({ key: `${c}:${idx}`, data: SEL_NUM + pad(c) + pad("0x" + idx.toString(16)), c, idx, den });
    }
    const numOut = await callAll(wanted, blockTag, "numerators");
    const values = {};
    for (const w of wanted) {
      const hex = numOut.results.get(w.key);
      if (hex == null) continue;
      const value = Number(BigInt(hex)) / Number(w.den);
      for (const tok of tokenOf.get(w.key) || []) values[tok] = value;
    }
    if (numOut.unanswered) console.log(`  ${numOut.unanswered} numerator calls never answered — those tokens keep their last-price mark`);

    const winners = Object.values(values).filter((v) => v > 0.5).length;
    out.edges[key] = {
      ts, block, tokensOpen: open[i].size, conditions: conditions.length,
      resolved: resolved.size, unansweredDen: denOut.unanswered, unansweredNum: numOut.unanswered,
      values, done: denOut.unanswered === 0,
    };
    writeFileSync(join(DIR, "payouts.json"), JSON.stringify(out));
    console.log(`  → ${Object.keys(values).length} tokens valued (${winners} paid out, ${Object.keys(values).length - winners} expired worthless)`);
  }

  console.log("\npayouts.json written");
}

main().catch((e) => { console.error(e); process.exit(1); });
