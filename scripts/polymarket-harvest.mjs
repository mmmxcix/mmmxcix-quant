// polymarket-harvest.mjs — every fill of a sampled set of wallets.
//
// THE DATA PATH, and why it is neither of the two the briefing expected.
// Polymarket's own domains are unreachable from this machine (polymarket.com,
// gamma-api, clob and data-api all fail to connect, over curl and PowerShell —
// re-verified 16 Aug 2026). The briefing offered reading Polygon logs directly,
// or proxying through a Pages function. There is a third way that is better than
// both: Polymarket's **public orderbook subgraph on Goldsky** answers from here,
// keyless, in ~0.3 s.
//
//   https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw
//                          /subgraphs/orderbook-subgraph/prod/gn
//
// It holds every OrderFilled event from 2022-11-21 to 2026-04-27 — the index is
// stalled ~100 days behind the chain head, which is fatal for a live copier and
// perfect for a study, since a study only ever looks at the past. Raw
// eth_getLogs would have meant scanning ~15M blocks per year through a public
// RPC's range limits; this is a GraphQL query with an index behind it.
//
// WHAT DOES NOT WORK, measured rather than assumed:
//   · `first` is capped at 1000.
//   · there are **455,444,548 fills**. Harvesting the lot is 455,000 requests
//     and is simply not on the table.
//   · `orderbooks(orderBy: tradesQuantity)` times out in the subgraph's own
//     Postgres, so there is no cheap "top wallets" list to start from.
//   · BUT `where: {maker: 0x…}` and `where: {takerAssetId: …}` are both indexed
//     and answer in ~0.3 s. That is the whole reason a wallet-centric harvest is
//     possible at all.
//
// So: sample a wallet universe from the fill stream, then pull each wallet's
// complete history. Two phases, both resumable.
//
//   node scripts/polymarket-harvest.mjs --wallets 2000
//   node scripts/polymarket-harvest.mjs --phase universe
//   node scripts/polymarket-harvest.mjs --phase trades
//
// Writes data/polymarket/{universe.json, wallets/<addr>.json} — gitignored.

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeFill } from "../src/lib/polymarket/trades.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "data", "polymarket");
const WDIR = join(DIR, "wallets");

const GS = process.env.POLYMARKET_SUBGRAPH
  || "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/prod/gn";

// The split. The wallet universe is sampled from the IN-SAMPLE window ONLY —
// sampling it from the whole span would let the selection see the period it is
// about to be judged on, which is the exact mistake this study exists to avoid.
export const T_SPLIT = Date.UTC(2025, 9, 1) / 1000;       // 2025-10-01
const SAMPLE_FROM = Date.UTC(2025, 0, 1) / 1000;          // 2025-01-01
const SAMPLE_TO = T_SPLIT;

const PAGE = 1000;
const PACE_MS = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

let queries = 0;
async function gql(query, tries = 4) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(GS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(60_000),
      });
      queries++;
      if (!r.ok) { await sleep(1000 * (a + 1)); continue; }
      const j = await r.json();
      // A subgraph error is not an empty result. Returning [] on a statement
      // timeout would silently turn "we could not read this wallet" into "this
      // wallet never traded", which is the worst kind of missing data.
      if (j.errors) { await sleep(1500 * (a + 1)); continue; }
      return j.data;
    } catch {
      await sleep(1500 * (a + 1));
    }
  }
  return null;
}

const FILL_FIELDS = "id timestamp maker taker makerAssetId takerAssetId makerAmountFilled takerAmountFilled fee";

// ── phase 1: the wallet universe ────────────────────────────────────────────

/**
 * Sample the fill stream at spread-out moments and collect the addresses that
 * show up.
 *
 * This is sampling proportional to ACTIVITY, and that is deliberate rather than
 * a compromise: you cannot copy a wallet that does not trade, so the population
 * the question is about is active wallets. It is emphatically NOT sampling on
 * profit — nothing here looks at whether an address made money, which is the
 * whole point. A leaderboard would have done exactly that and would have handed
 * back the survivors of a coin-flipping tournament.
 */
async function buildUniverse(target) {
  const path = join(DIR, "universe.json");
  if (existsSync(path)) {
    const u = JSON.parse(readFileSync(path, "utf8"));
    console.log(`universe: cached — ${u.wallets.length} wallets from ${u.samples} samples`);
    return u;
  }
  const counts = new Map();
  const span = SAMPLE_TO - SAMPLE_FROM;
  const samples = 260;                       // ~one per working day of the window
  for (let i = 0; i < samples; i++) {
    const at = Math.floor(SAMPLE_FROM + (span * i) / samples);
    const d = await gql(`{ orderFilledEvents(first:${PAGE}, orderBy:timestamp, where:{timestamp_gte:${at}}) { maker taker } }`);
    for (const f of d?.orderFilledEvents || []) {
      for (const a of [f.maker, f.taker]) {
        if (!/^0x[0-9a-f]{40}$/.test(a || "")) continue;
        counts.set(a, (counts.get(a) || 0) + 1);
      }
    }
    if ((i + 1) % 40 === 0) console.log(`universe: ${i + 1}/${samples} samples, ${counts.size} addresses seen`);
    await sleep(PACE_MS);
  }

  // Addresses seen once are mostly one-off retail and the exchange's own
  // contracts on the taker side; requiring a few appearances keeps the harvest
  // bounded AND keeps the population to wallets a copier could actually follow.
  // Stratified across the activity range, not the top of it. Taking the N most
  // active addresses would be a universe of market makers; taking the N least
  // would be a universe of dabblers. Every k-th address of the ranked list keeps
  // the spread, and `sampleHits` travels with each so the analysis can say which
  // part of the range a result came from.
  const ranked = [...counts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  const step = Math.max(1, Math.floor(ranked.length / target));
  const wallets = [];
  for (let i = 0; i < ranked.length && wallets.length < target; i += step) {
    wallets.push({ address: ranked[i][0], sampleHits: ranked[i][1] });
  }

  const out = { builtAt: Date.now(), samples, sampleFrom: SAMPLE_FROM, sampleTo: SAMPLE_TO, seen: counts.size, wallets };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(out));
  console.log(`universe: ${counts.size} addresses seen, ${wallets.length} kept (>=3 appearances)`);
  return out;
}

// ── phase 2: every fill of every sampled wallet ─────────────────────────────

// A wallet that fills tens of thousands of times is a MARKET MAKER, not a
// trader anyone could copy: by the time a copier has read the fill, the maker
// has quoted both sides again. Twenty pages is 20,000 fills per side, well past
// any plausible copy target. Wallets that hit the cap are recorded as
// `truncated` and excluded from the study by name rather than quietly dropped —
// and hitting it first also stalled the harvest for ten minutes on a single
// address, because the universe is sorted most-active-first.
const MAX_PAGES = 20;

/** All fills where the address is on one given side, cursor-paginated by id. */
async function sideFills(address, side) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const where = `{${side}:"${address}"${cursor ? `, id_gt:"${cursor}"` : ""}}`;
    const d = await gql(`{ orderFilledEvents(first:${PAGE}, orderBy:id, where:${where}) { ${FILL_FIELDS} } }`);
    if (!d) return null;                      // a read failure is not "no trades"
    const rows = d.orderFilledEvents || [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
    cursor = rows[rows.length - 1].id;
    await sleep(PACE_MS);
  }
  out.truncated = true;                       // hit the cap — a market maker
  return out;
}

async function harvestWallet(address) {
  const path = join(WDIR, `${address}.json`);
  if (existsSync(path)) return null;
  const [asMaker, asTaker] = await Promise.all([sideFills(address, "maker"), sideFills(address, "taker")]);
  if (asMaker === null || asTaker === null) return null;   // leave it unwritten; a rerun retries
  // The same fill can appear on both sides only if a wallet traded with itself;
  // dedupe by id so that cannot double-count.
  const truncated = !!(asMaker.truncated || asTaker.truncated);
  const byId = new Map();
  for (const f of [...asMaker, ...asTaker]) byId.set(f.id, f);
  // Decode and compact HERE rather than storing the raw events. Polymarket
  // splits one order into many small fills, so a normal-looking trader carries
  // ~12,000 of them; the first attempt at this wrote 181 MB for 36 wallets and
  // was on course for 10 GB. The decoded row keeps only what any downstream
  // question needs — when, which token, which way, how much cash, how many
  // shares — and drops the three hashes that were most of the bytes.
  const trades = [];
  for (const f of [...byId.values()].sort((a, b) => +a.timestamp - +b.timestamp)) {
    const t = decodeFill(f);
    if (!t || t.wallet !== address) continue;   // taker-side rows price the OTHER party
    trades.push([t.ts, t.tokenId, t.side === "buy" ? 1 : 0, +t.usdc.toFixed(6), +t.tokens.toFixed(6)]);
  }
  writeFileSync(path, JSON.stringify({ address, harvestedAt: Date.now(), truncated, rawFills: byId.size, trades }));
  return { n: trades.length, truncated };
}

async function harvestTrades(universe) {
  mkdirSync(WDIR, { recursive: true });
  const done = new Set(readdirSync(WDIR).map((f) => f.replace(/\.json$/, "")));
  // LEAST active first. The universe is sorted most-active-first, and starting
  // there means the first ten minutes buy exactly one market maker nobody can
  // copy — the harvest looked hung when it was merely being thorough about the
  // least useful address in the set.
  const todo = universe.wallets.filter((w) => !done.has(w.address)).slice().reverse();
  console.log(`trades: ${done.size} wallets already on disk, ${todo.length} to go`);
  let n = 0, fills = 0, failed = 0, mm = 0;
  for (const w of todo) {
    const got = await harvestWallet(w.address);
    n++;
    if (got === null) failed++;
    else { fills += got.n; if (got.truncated) mm++; }
    if (n % 25 === 0) console.log(`trades: ${n}/${todo.length} wallets, ${fills} fills, ${mm} market makers (capped), ${failed} unread, ${queries} queries`);
  }
  console.log(`trades: done — ${n} wallets this run, ${fills} fills, ${mm} capped, ${failed} unread`);
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const phase = arg("phase", "all");
  const target = +arg("wallets", 2000);
  const universe = await buildUniverse(target);
  if (phase === "universe") return;
  await harvestTrades(universe);
}

main().catch((e) => { console.error(e); process.exit(1); });
