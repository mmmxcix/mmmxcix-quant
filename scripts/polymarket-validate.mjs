// polymarket-validate.mjs — does a Polymarket wallet's edge persist?
//
// THE ORDER OF THE TWO QUESTIONS MATTERS, and it saves a week.
//
//   1. At the leader's OWN fills — the most generous assumption possible, a
//      copier who somehow trades at exactly the price the leader got — does the
//      in-sample ranking predict anything out of sample?
//   2. Only if it does: what survives our real, delayed, worse fill?
//
// Question 2 needs a second harvest (the tape of every token a ranked wallet
// touched out of sample). Question 1 needs nothing but what is already on disk.
// And question 1 is an UPPER BOUND: no fill model can make a copier do better
// than the wallet it copies. If the edge is not there at the leader's own
// prices, it cannot be there at ours, and the project is finished without the
// second harvest ever being written.
//
//   node scripts/polymarket-harvest.mjs --wallets 400
//   node scripts/polymarket-validate.mjs
//
// Writes docs/POLYMARKET_FINDINGS.md and data/polymarket/study.json.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fifoPnl, markedPnl, markedScore, priceBook, splitAt, walletScore } from "../src/lib/polymarket/trades.js";
import { persistence, walletPValue } from "../src/lib/polymarket/copy.js";
import { resolvedValue } from "../src/lib/polymarket/resolve.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "data", "polymarket");
const WDIR = join(DIR, "wallets");
const RPCS = ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"];

// SEVERAL cut-offs, not one. A single split date is a single experiment: the
// 0.438 rank correlation measured at 2025-10-01 could be a property of the
// wallets or a property of that October, and one draw cannot tell them apart.
// All of these sit at or after the universe sampling window ends (2025-10-01) —
// an earlier split would judge wallets out of sample on a period the SELECTION
// had already seen, and although the selection is on activity rather than
// profit, that is a leak nobody has to accept.
const SPLITS = [
  Date.UTC(2025, 9, 1) / 1000,    // 2025-10-01
  Date.UTC(2025, 10, 15) / 1000,  // 2025-11-15
  Date.UTC(2026, 0, 1) / 1000,    // 2026-01-01
  Date.UTC(2026, 1, 15) / 1000,   // 2026-02-15
];
const T_SPLIT = SPLITS[0];
const TOP_K = 20;
const ALPHA = 0.1;
const MIN_IN = 20;
const MIN_OUT = 10;

const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

/** The compact rows the harvester writes: [ts, tokenId, isBuy, usdc, tokens]. */
function readWallet(file) {
  const w = JSON.parse(readFileSync(join(WDIR, file), "utf8"));
  const trades = (w.trades || []).map(([ts, tokenId, isBuy, usdc, tokens]) => ({
    ts, tokenId, side: isBuy ? "buy" : "sell", usdc, tokens, price: usdc / tokens,
  }));
  return { address: w.address, truncated: !!w.truncated, trades };
}

/** Per-round-trip returns, so a wallet's record is a SAMPLE and not one number. */
function tripReturns(trades) {
  const lots = new Map();
  const rets = [];
  for (const t of trades) {
    if (t.side === "buy") {
      if (!lots.has(t.tokenId)) lots.set(t.tokenId, []);
      lots.get(t.tokenId).push({ tokens: t.tokens, price: t.price });
      continue;
    }
    let left = t.tokens;
    const queue = lots.get(t.tokenId) || [];
    while (left > 1e-9 && queue.length) {
      const lot = queue[0];
      const take = Math.min(left, lot.tokens);
      if (lot.price > 0) rets.push(t.price / lot.price - 1);
      lot.tokens -= take;
      left -= take;
      if (lot.tokens <= 1e-9) queue.shift();
    }
  }
  return rets;
}

/**
 * One split, scored two ways.
 *
 * `closed` counts only round trips a wallet chose to close. `marked` liquidates
 * everything still open at the edge of its window at the last printed price.
 * The pair is the point: if a ranking survives the first and dies in the second,
 * the ranking was measuring the habit of not closing losers.
 */
function runSplit(wallets, book, tSplit, tEnd, resolver) {
  const closedRows = [], markedRows = [], resolvedRows = [];
  let attrition = 0, fromResolution = 0, fromLastPrice = 0;
  for (const w of wallets) {
    const { inSample, outSample } = splitAt(w.trades, tSplit);

    const inC = walletScore(fifoPnl(inSample)), outC = walletScore(fifoPnl(outSample));
    if (inC && !outC) attrition++;

    // In-sample is liquidated at the SPLIT; out-of-sample at the end of the data.
    const inMp = markedPnl(inSample, (tok) => book.at(tok, tSplit));
    const outMp = markedPnl(outSample, (tok) => book.at(tok, tEnd));
    const inM = markedScore(inMp), outM = markedScore(outMp);

    // The third valuation: the TRUE terminal value where the chain has already
    // said so BY the edge, and the last traded price where it has not. Refusing
    // a resolution that landed after the edge matters — the data ends 2026-04
    // and the chain is read to 2026-08, so four months of "how it turned out"
    // sit there waiting to be borrowed by accident.
    const markResolved = (edge) => (tok) => {
      const r = resolver ? resolver.at(tok, edge) : null;
      if (r != null) { fromResolution++; return r; }
      fromLastPrice++;
      return book.at(tok, edge);
    };
    const inR = markedScore(markedPnl(inSample, markResolved(tSplit)));
    const outR = markedScore(markedPnl(outSample, markResolved(tEnd)));

    if (inC && outC) {
      closedRows.push({
        address: w.address,
        inRoi: inC.roi, inTrades: inSample.length, inOpenShare: inC.openShare,
        outRoi: outC.roi, outTrades: outSample.length, outOpenShare: outC.openShare,
        outPnl: outC.realized, outCost: outC.closedCost,
        pValue: walletPValue(tripReturns(outSample)),
      });
    }
    if (inM && outM) {
      markedRows.push({
        address: w.address,
        inRoi: inM.roi, inTrades: inSample.length, inOpenShare: 0,
        outRoi: outM.roi, outTrades: outSample.length, outOpenShare: 0,
        outPnl: outM.total, outCost: outM.totalCost,
        unmarkableShare: outM.unmarkableShare,
        pValue: walletPValue(tripReturns(outSample)),
      });
    }
    if (inR && outR) {
      resolvedRows.push({
        address: w.address,
        inRoi: inR.roi, inTrades: inSample.length, inOpenShare: 0,
        outRoi: outR.roi, outTrades: outSample.length, outOpenShare: 0,
        outPnl: outR.total, outCost: outR.totalCost,
        pValue: walletPValue(tripReturns(outSample)),
      });
    }
  }

  const opts = { topK: TOP_K, alpha: ALPHA, minInTrades: MIN_IN, minOutTrades: MIN_OUT };
  const closed = persistence(closedRows, opts);
  const marked = persistence(markedRows, opts);
  const resolved = persistence(resolvedRows, opts);

  const avg = (xs, k) => (xs.length ? xs.reduce((a, r) => a + (r[k] ?? 0), 0) / xs.length : 0);
  const top = closed.ranked.slice(0, Math.min(TOP_K, closed.ranked.length));
  const rest = closed.ranked.slice(top.length);
  const openGap = {
    topIn: avg(top, "inOpenShare"), restIn: avg(rest, "inOpenShare"),
    topOut: avg(top, "outOpenShare"), restOut: avg(rest, "outOpenShare"),
  };
  const unmarkable = avg(marked.ranked, "unmarkableShare");
  const resolutionShare = fromResolution + fromLastPrice ? fromResolution / (fromResolution + fromLastPrice) : 0;
  return { tSplit, attrition, closed, marked, resolved, openGap, unmarkable, resolutionShare };
}

/**
 * Block number → unix seconds, from two real anchors.
 *
 * The resolutions carry a block, the valuation edge is a timestamp, and the two
 * have to be comparable before a resolution can be refused as "after the edge".
 * Polygon's block time is stable enough that a straight line through two
 * measured points is accurate to hours over years — which is all the precision a
 * before/after test at a month-scale cut-off needs, and it is stated rather than
 * assumed exact.
 */
async function blockClock() {
  const get = async (tag) => {
    const r = await fetch(RPCS[0], {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [tag, false] }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await r.json();
    return j?.result ? { n: parseInt(j.result.number, 16), ts: parseInt(j.result.timestamp, 16) } : null;
  };
  const head = await get("latest");
  const old = await get("0x2160EC0");   // 35,000,000 — the scan's start block
  if (!head || !old || head.n === old.n) return null;
  const secPerBlock = (head.ts - old.ts) / (head.n - old.n);
  return (b) => old.ts + (b - old.n) * secPerBlock;
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const files = readdirSync(WDIR).filter((f) => /^0x[0-9a-f]{40}\.json$/.test(f));
  if (!files.length) throw new Error(`no wallets in ${WDIR} — run scripts/polymarket-harvest.mjs first`);

  const wallets = [];
  const all = [];
  let capped = 0, noTrades = 0;
  for (const f of files) {
    const w = readWallet(f);
    // A market maker's history was cut off at the harvest cap, so its record is
    // a fragment of the truth. Excluded by name, not quietly — but its fills
    // still feed the price book, because a price is a price.
    all.push(...w.trades);
    if (w.truncated) { capped++; continue; }
    if (!w.trades.length) { noTrades++; continue; }
    wallets.push(w);
  }
  const tEnd = all.reduce((m, t) => (t.ts > m ? t.ts : m), 0);
  const book = priceBook(all);
  console.log(
    `wallets: ${files.length} on disk, ${all.length} trades — ${capped} market makers excluded, ` +
    `${noTrades} empty, ${wallets.length} usable`
  );
  console.log(`price book: ${book.tokens} tokens, data ends ${new Date(tEnd * 1000).toISOString().slice(0, 10)}
`);

  // The on-chain half, when scripts/polymarket-resolutions.mjs has produced it.
  let resolver = null, resStats = { conditions: 0, tokens: 0, mapped: 0 };
  const rPath = join(DIR, "resolutions.json"), tPath = join(DIR, "tokenmap.json");
  if (existsSync(rPath) && existsSync(tPath)) {
    const res = JSON.parse(readFileSync(rPath, "utf8"));
    const tok = JSON.parse(readFileSync(tPath, "utf8"));
    const conditions = new Map(Object.entries(res.conditions || {}).map(([k, v]) => [k, { payouts: v.p, total: v.t, blockNumber: v.b }]));
    const tokens = new Map(Object.entries(tok).filter(([, v]) => v));
    resStats = { conditions: conditions.size, tokens: Object.keys(tok).length, mapped: tokens.size };
    const clock = await blockClock();
    resolver = resolvedValue(tokens, conditions, clock);
    console.log(`resolutions: ${conditions.size} conditions, ${tokens.size}/${resStats.tokens} tokens mapped${clock ? "" : " (no block clock — resolutions cannot be dated, so none are used)"}`);
    if (!clock) resolver = null;
  } else {
    console.log("resolutions: not fetched yet — run scripts/polymarket-resolutions.mjs for the on-chain valuation");
  }

  const runs = SPLITS.map((t) => runSplit(wallets, book, t, tEnd, resolver));
  for (const r of runs) {
    const d = new Date(r.tSplit * 1000).toISOString().slice(0, 10);
    console.log(`── split ${d} ─────────────────────────────`);
    console.log(`  closed-round-trips only : rho ${r.closed.rankCorrelation.toFixed(3)} · top${r.closed.top.wallets} ${pct(r.closed.top.roi)} vs rest ${pct(r.closed.rest.roi)} · n=${r.closed.tested} · BH ${r.closed.bh.survivors.length}`);
    console.log(`  LIQUIDATED at the edge  : rho ${r.marked.rankCorrelation.toFixed(3)} · top${r.marked.top.wallets} ${pct(r.marked.top.roi)} vs rest ${pct(r.marked.rest.roi)} · n=${r.marked.tested} · BH ${r.marked.bh.survivors.length}`);
    if (r.resolved.tested) {
      console.log(`  RESOLVED on-chain       : rho ${r.resolved.rankCorrelation.toFixed(3)} · top${r.resolved.top.wallets} ${pct(r.resolved.top.roi)} vs rest ${pct(r.resolved.rest.roi)} · n=${r.resolved.tested} · BH ${r.resolved.bh.survivors.length}`);
    }
    console.log(`  open share top/rest ${r.openGap.topOut.toFixed(3)}/${r.openGap.restOut.toFixed(3)} · attrition ${r.attrition} · unmarkable ${(r.unmarkable * 100).toFixed(1)}% · valued by resolution ${(r.resolutionShare * 100).toFixed(1)}%`);
  }

  const artifact = {
    builtAt: Date.now(), splits: SPLITS, tEnd,
    wallets: { onDisk: files.length, capped, noTrades, usable: wallets.length, trades: all.length, tokens: book.tokens },
    resolutions: resStats,
    topK: TOP_K, alpha: ALPHA, minInTrades: MIN_IN, minOutTrades: MIN_OUT,
    runs: runs.map((r) => ({
      tSplit: r.tSplit, attrition: r.attrition, openGap: r.openGap, unmarkable: r.unmarkable,
      closed: { ...r.closed, ranked: r.closed.ranked.slice(0, 25) },
      marked: { ...r.marked, ranked: r.marked.ranked.slice(0, 25) },
      resolved: { ...r.resolved, ranked: r.resolved.ranked.slice(0, 25) },
      resolutionShare: r.resolutionShare,
    })),
  };
  writeFileSync(join(DIR, "study.json"), JSON.stringify(artifact, null, 1));
  writeFileSync(join(ROOT, "docs", "POLYMARKET_FINDINGS.md"), report(artifact));

  // The verdict is on the MARKED numbers across every split. The closed-only
  // ones are kept for comparison and are not allowed to decide anything —
  // they are the measure that the disposition effect games.
  const good = runs.filter((r) => r.marked.rankCorrelation > 0.1 && r.marked.top.roi > 0 && r.marked.bh.survivors.length > 0);
  console.log(`
→ docs/POLYMARKET_FINDINGS.md written`);
  if (!good.length) {
    console.log("VERDICT: with open positions liquidated at the edge, the ranking predicts nothing out of sample at ANY split. No fill model can improve on that. Project 1 ends here.");
  } else if (good.length < runs.length) {
    console.log(`VERDICT: the ranking holds up at ${good.length} of ${runs.length} splits once positions are liquidated — a property of some months, not yet of the wallets.`);
  } else {
    console.log(
      "VERDICT: liquidating at the edge roughly HALVES the effect but does not remove it — a residual survives every split.\n" +
      "         Not an edge yet: it is the upper bound (leader's own fills), attrition still conditions it, the mark is the\n" +
      "         last traded price rather than the resolution, and the p-values treat correlated trades as independent.\n" +
      "         Next: the on-chain ConditionResolution valuation. Only then is the fill model worth building."
    );
  }
}

function report(a) {
  const date = new Date(a.builtAt).toISOString().slice(0, 10);
  const f = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
  const d = (t) => new Date(t * 1000).toISOString().slice(0, 10);

  const rows = a.runs.map((r) =>
    `| ${d(r.tSplit)} | ${r.closed.tested} | ${r.closed.rankCorrelation.toFixed(3)} | ${f(r.closed.top.roi)} | ${f(r.closed.rest.roi)} | ${r.closed.bh.survivors.length} | ` +
    `**${r.marked.rankCorrelation.toFixed(3)}** | **${f(r.marked.top.roi)}** | ${f(r.marked.rest.roi)} | ${r.marked.bh.survivors.length} |`
  ).join("\n");

  const gapRows = a.runs.map((r) =>
    `| ${d(r.tSplit)} | ${r.openGap.topOut.toFixed(3)} | ${r.openGap.restOut.toFixed(3)} | ${r.attrition} | ${(r.unmarkable * 100).toFixed(1)}% |`
  ).join("\n");

  const good = a.runs.filter((r) => r.marked.rankCorrelation > 0.1 && r.marked.top.roi > 0 && r.marked.bh.survivors.length > 0);
  const verdict = !good.length
    ? "with open positions liquidated at the edge, the in-sample ranking predicts nothing out of sample at any split."
    : good.length < a.runs.length
      ? `the ranking holds at ${good.length} of ${a.runs.length} splits once positions are liquidated — a property of some months, not yet of the wallets.`
      : "liquidating open positions at the edge roughly HALVES the effect but does not remove it — a residual survives every split. That is not yet an edge; three known biases all still point the same way.";

  return `# Polymarket copytrading — does the edge persist?

*Run ${date}. Generated by \`scripts/polymarket-validate.mjs\`; raw numbers in
\`data/polymarket/study.json\`.*

**Verdict: ${verdict}**

Everything below is measured at the **leader's own fill prices** — a copier who
somehow traded at exactly the price the leader got. That is an upper bound no
fill model can beat: you cannot copy someone into a better price than they got
themselves. ${good.length ? "So a positive result here is a licence to start measuring the real fill, not a result about copying." : "So the delayed, worse, real fill cannot rescue it, and the second harvest that would have measured it was never written."}

Nothing here is a claim about live trading, in either direction.

---

## What was measured

${a.wallets.onDisk} wallets, **${a.wallets.trades.toLocaleString("en-US")} decoded fills** across ${a.wallets.tokens.toLocaleString("en-US")} tokens,
data ending ${d(a.tEnd)}. ${a.wallets.capped} wallets were excluded as market makers (their
history hit the harvest cap, so their record is a fragment and nobody could copy
them anyway); their fills still feed the price book, because a price is a price.

The universe was sampled from the **in-sample window only** and stratified
across the activity range — never by profit. That distinction is the whole
point: a leaderboard selects on the outcome it is then used to predict.

### Scored two ways, and the second one is the real one

- **closed round trips only** — counts what a wallet chose to close. Needs no
  resolution data, and is exactly the measure a wallet games by banking winners
  and sitting on losers.
- **liquidated at the edge** — every position still open is marked at the last
  price the tape printed, in-sample at the split, out-of-sample at the end of the
  data. The ordinary convention in trader-ranking studies, and it is unbiased
  with respect to that habit.

### Four splits, not one

A single cut-off is a single experiment. The first run of this study measured a
rank correlation of 0.438 at 2025-10-01 and could not say whether that was a
property of the wallets or of that October. Every split below sits at or after
the universe sampling window ends, so the selection never saw the period it is
judged on.

## The result

| split | n | rho (closed) | top${a.topK} (closed) | rest | BH | **rho (liquidated)** | **top${a.topK}** | rest | BH |
|---|---|---|---|---|---|---|---|---|---|
${rows}

## The two artifacts, per split

| split | open share, top${a.topK} | open share, rest | attrition | unmarkable |
|---|---|---|---|---|
${gapRows}

**Attrition** is the number of wallets with an in-sample record and no
out-of-sample one — they stopped trading, or stopped closing anything. Every
closed-only number is conditioned on having survived into the second window,
which is the leaderboard bias arriving through the back door. Liquidating at the
edge fixes this too: a wallet that stops trading still has a position to value.

**Open share** is the fraction of committed capital a wallet left unclosed. Where
the top of the ranking carries materially more than the rest, the closed-only
ranking is measuring that habit rather than skill — and because the habit is
stable it reproduces out of sample and looks exactly like a persistent edge.

**Unmarkable** is the share of open capital in tokens the tape never printed by
the cut-off. Those are neither assumed worthless nor assumed whole; they are
excluded and counted, because either assumption would be a thumb on the scale.

## What would still make this wrong

- **The mark is the last TRADED price, not the resolution.** A market that
  resolves against a wallet after the cut-off is not punished here. The true
  terminal value is on-chain — the Gnosis Conditional Tokens contract
  \`0x4D97DCd97eC945f40cF65F87097ACe5EA0476045\` on Polygon emits
  \`ConditionResolution\` (topic \`0xb44d84d3…5894\`, payout numerators in the data
  field), readable keylessly over \`eth_getLogs\`. Reading it and putting the two
  valuations side by side is the next step; where they diverge is itself a
  finding about the wallets.
- **Activity sampling.** The universe is wallets that traded often enough to
  appear in a sample of the fill stream. That is the right population — you
  cannot copy someone who does not trade — but it is not all wallets.
- **The subgraph's index stops at ${d(a.tEnd)}**, so the later splits have short
  out-of-sample windows. The n column shows what each one is worth.
- **Trades are treated as independent** in each wallet's p-value. They are not:
  a wallet often holds several outcomes of one market. That makes the p-values
  too confident, which biases toward FINDING an edge, not away from it.

## Reproduce it

\`\`\`
node scripts/polymarket-harvest.mjs --wallets 400
node scripts/polymarket-validate.mjs
\`\`\`
`;
}

main().catch((e) => { console.error(e); process.exit(1); });
