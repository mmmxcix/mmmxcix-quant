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

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { fifoPnl, splitAt, walletScore } from "../src/lib/polymarket/trades.js";
import { persistence, walletPValue } from "../src/lib/polymarket/copy.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "data", "polymarket");
const WDIR = join(DIR, "wallets");

const T_SPLIT = Date.UTC(2025, 9, 1) / 1000;   // must match the harvester
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

function main() {
  mkdirSync(DIR, { recursive: true });
  const files = readdirSync(WDIR).filter((f) => /^0x[0-9a-f]{40}\.json$/.test(f));
  if (!files.length) throw new Error(`no wallets in ${WDIR} — run scripts/polymarket-harvest.mjs first`);

  const rows = [];
  let capped = 0, noTrades = 0, totalTrades = 0, attrition = 0;
  for (const f of files) {
    const w = readWallet(f);
    totalTrades += w.trades.length;
    // A market maker's history was cut off at the harvest cap, so its in-sample
    // record is a fragment of the truth. Excluded by name, not quietly.
    if (w.truncated) { capped++; continue; }
    if (!w.trades.length) { noTrades++; continue; }

    const { inSample, outSample } = splitAt(w.trades, T_SPLIT);
    const inPnl = fifoPnl(inSample), outPnl = fifoPnl(outSample);
    const inScore = walletScore(inPnl), outScore = walletScore(outPnl);
    // ATTRITION. A wallet with an in-sample record and no out-of-sample one has
    // not been neutral — it stopped trading, or stopped closing anything. Every
    // number below is conditioned on having survived into the second window, and
    // counting how many did not is the only thing that keeps that visible.
    if (inScore && !outScore) attrition++;
    if (!inScore || !outScore) continue;

    const outRets = tripReturns(outSample);
    rows.push({
      address: w.address,
      inRoi: inScore.roi, inTrades: inSample.length, inCost: inPnl.closedCost, inPnl: inPnl.realized,
      outRoi: outScore.roi, outTrades: outSample.length, outCost: outPnl.closedCost, outPnl: outPnl.realized,
      outOpenShare: outScore.openShare, inOpenShare: inScore.openShare,
      pValue: walletPValue(outRets),
    });
  }

  console.log(
    `wallets: ${files.length} on disk, ${totalTrades} trades — ` +
    `${capped} market makers excluded (harvest cap), ${noTrades} empty, ${rows.length} scoreable`
  );

  const p = persistence(rows, { topK: TOP_K, alpha: ALPHA, minInTrades: MIN_IN, minOutTrades: MIN_OUT });
  console.log(`tested: ${p.tested} wallets (${p.skipped} below the trade floors)`);
  console.log(`rank correlation in→out (Spearman): ${p.rankCorrelation.toFixed(3)}`);
  console.log(`top ${p.top.wallets} by in-sample ROI  → out-of-sample ROI ${pct(p.top.roi)} (${p.top.positive}/${p.top.wallets} positive)`);
  console.log(`the other ${p.rest.wallets}              → out-of-sample ROI ${pct(p.rest.roi)} (${p.rest.positive}/${p.rest.wallets} positive)`);
  console.log(`all ${p.all.wallets}                     → out-of-sample ROI ${pct(p.all.roi)}`);
  console.log(`Benjamini-Hochberg at alpha ${ALPHA}: ${p.bh.survivors.length} survivor(s), ~${p.bh.expectedFalse} expected false`);

  // THE DIAGNOSTIC THAT DECIDES IT. Closed-round-trip P&L counts only what a
  // wallet CHOSE to close, so a wallet that banks winners and sits on losers
  // scores well by construction. If the top of the ranking leaves systematically
  // more capital open than the rest, the ranking is measuring that habit — and
  // because the habit is stable, it reproduces out of sample and looks exactly
  // like a persistent edge.
  const topRows = p.ranked.slice(0, Math.min(TOP_K, p.ranked.length));
  const restRows = p.ranked.slice(topRows.length);
  const avg = (xs, k) => (xs.length ? xs.reduce((a, r) => a + (r[k] ?? 0), 0) / xs.length : 0);
  const openGap = {
    topIn: avg(topRows, "inOpenShare"), restIn: avg(restRows, "inOpenShare"),
    topOut: avg(topRows, "outOpenShare"), restOut: avg(restRows, "outOpenShare"),
  };
  console.log(`open share (unclosed capital)  in-sample  top ${openGap.topIn.toFixed(3)} vs rest ${openGap.restIn.toFixed(3)}`);
  console.log(`open share (unclosed capital)  out-sample top ${openGap.topOut.toFixed(3)} vs rest ${openGap.restOut.toFixed(3)}`);
  console.log(`attrition: ${attrition} wallets had an in-sample record and NO out-of-sample one`);

  const artifact = {
    builtAt: Date.now(), tSplit: T_SPLIT,
    openGap,
    wallets: { onDisk: files.length, capped, noTrades, scoreable: rows.length, trades: totalTrades, attrition },
    topK: TOP_K, alpha: ALPHA, minInTrades: MIN_IN, minOutTrades: MIN_OUT,
    persistence: { ...p, ranked: p.ranked.slice(0, 60) },
  };
  writeFileSync(join(DIR, "study.json"), JSON.stringify(artifact, null, 1));
  writeFileSync(join(ROOT, "docs", "POLYMARKET_FINDINGS.md"), report(artifact));

  // A raw pass is not enough. The ranking has to predict AND not be explained by
  // the two artifacts that would produce the same picture for free.
  const looksPositive = p.bh.survivors.length > 0 && p.rankCorrelation > 0.1 && p.top.roi > 0;
  const dispositionExplains = openGap.topOut > openGap.restOut * 1.2;
  const attritionSevere = attrition > rows.length;
  console.log(`\n→ docs/POLYMARKET_FINDINGS.md written`);
  if (!looksPositive) {
    console.log("VERDICT: the ranking does not predict out of sample, at the leader's own fills. No fill model can improve on that, so the project ends here.");
  } else if (dispositionExplains || attritionSevere) {
    console.log("VERDICT: the ranking DOES predict out of sample — and so would a wallet that simply never closes its losers. NOT established as an edge; see the diagnostics.");
  } else {
    console.log("VERDICT: the ranking predicts out of sample and neither artifact explains it — question 2 (our fill) is now worth building.");
  }
}

function report(a) {
  const p = a.persistence;
  const date = new Date(a.builtAt).toISOString().slice(0, 10);
  const split = new Date(a.tSplit * 1000).toISOString().slice(0, 10);
  const f = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

  const rows = p.ranked.slice(0, 20).map((r) =>
    `| ${r.inRank} | \`${r.address.slice(0, 10)}…\` | ${f(r.inRoi)} | ${r.inTrades} | ${f(r.outRoi)} | ${r.outTrades} | ${r.pValue.toFixed(3)} | ${r.q.toFixed(3)} |`
  ).join("\n");

  const passed = p.bh.survivors.length > 0 && p.rankCorrelation > 0.1 && p.top.roi > 0;

  return `# Polymarket copytrading — does the edge persist?

*Run ${date}. Generated by \`scripts/polymarket-validate.mjs\`; raw numbers in
\`data/polymarket/study.json\`.*

**Verdict: ${!passed
      ? "the in-sample ranking does not predict out of sample."
      : (a.openGap.topOut > a.openGap.restOut * 1.2 || a.wallets.attrition > a.wallets.scoreable)
        ? "the in-sample ranking DOES predict out of sample — and so would a wallet that simply never closes its losers. Not established as an edge."
        : "the in-sample ranking predicts out of sample and neither artifact explains it. Question 2 — what survives OUR fill — is now worth measuring."}**

${passed ? "" : `This is measured at the **leader's own fill prices** — a copier who somehow
traded at exactly the price the leader got. That is an upper bound no fill model
can beat: you cannot copy someone into a better price than they got themselves.
So the delayed, worse, real fill cannot rescue it, and the second harvest that
would have measured it was never written.`}

Nothing here is a claim about live trading, in either direction.

---

## What was measured

${a.wallets.onDisk} wallets, **${a.wallets.trades.toLocaleString("en-US")} decoded fills**, split at **${split}**:
everything before it ranks a wallet, everything after it judges the ranking.

The wallet universe was sampled from the **in-sample window only** and
stratified across the activity range — never by profit. That distinction is the
whole point: a leaderboard selects on the outcome it is then used to predict,
which is why the top of one is, by construction, whoever got luckiest.

${a.wallets.capped} wallets were excluded because the harvest capped their history at 20,000
fills per side — those are market makers, whose in-sample record would be a
fragment, and who nobody could copy anyway. ${a.wallets.noTrades} had no decodable trades.
A wallet needs ${a.minInTrades} in-sample and ${a.minOutTrades} out-of-sample trades to be tested at all;
${p.skipped} fell short and were not tested rather than tested badly.

P&L is FIFO on closed round trips only, which needs no market-resolution data.
Its known bias travels with it: a wallet that takes profits and sits on losers
looks better than it is, and the open remainder is reported per wallet.

## The result

| | |
|---|---|
| wallets tested | ${p.tested} |
| **rank correlation, in-sample → out-of-sample** | **${p.rankCorrelation.toFixed(3)}** (Spearman) |
| top ${p.top.wallets} by in-sample ROI → out-of-sample | **${f(p.top.roi)}** (${p.top.positive}/${p.top.wallets} positive) |
| everyone else → out-of-sample | ${f(p.rest.roi)} (${p.rest.positive}/${p.rest.wallets} positive) |
| all tested → out-of-sample | ${f(p.all.roi)} |
| Benjamini–Hochberg survivors (α = ${p.bh.alpha}) | **${p.bh.survivors.length}** of ${p.tested}, ~${p.bh.expectedFalse} expected false |

The rank correlation is the question in one number: if picking the best
in-sample wallets told you anything about the future, it would be positive and
large. Benjamini–Hochberg is there because ${p.tested} wallets were tested at once —
without it, finding a handful with a good p-value is what the null predicts, not
a discovery. It is the same correction \`src/lib/pairsScreen.js\` applies to pair
screening, for the same reason.

### The top of the in-sample ranking, and what happened next

| rank | wallet | in ROI | in trades | **out ROI** | out trades | p | q (BH) |
|---|---|---|---|---|---|---|---|
${rows}

## The two artifacts that would produce this picture for free

A positive result here is the moment to be most suspicious, not least. Two
things would reproduce everything in the table above without any skill existing,
and both are measured rather than argued about.

**1 · Attrition.** ${a.wallets.attrition} wallets had an in-sample record and **no
out-of-sample one** — they stopped trading, or stopped closing anything, after
the split. That is ${((a.wallets.attrition / (a.wallets.attrition + a.wallets.scoreable)) * 100).toFixed(0)}% of the wallets that had a record to begin with.
Everything in the result is therefore conditioned on having survived into the
second window, which is the same shape of bias as the leaderboard this study was
built to avoid, arriving through the back door.

**2 · The disposition effect, and this one is decisive.** Closed-round-trip P&L
counts only what a wallet CHOSE to close. A wallet that banks its winners and
sits on its losers scores well by construction — and the habit is stable, so it
reproduces out of sample and looks exactly like a persistent edge.

| unclosed share of capital | top ${a.topK} | everyone else |
|---|---|---|
| in-sample | **${a.openGap.topIn.toFixed(3)}** | ${a.openGap.restIn.toFixed(3)} |
| out-of-sample | **${a.openGap.topOut.toFixed(3)}** | ${a.openGap.restOut.toFixed(3)} |

${a.openGap.topIn > a.openGap.restIn * 1.2
      ? `The top of the ranking leaves roughly **${(a.openGap.topIn / Math.max(a.openGap.restIn, 1e-9)).toFixed(1)}×** as much capital in
unclosed positions as everyone else. The ranking is at least partly measuring
that habit rather than skill, and no amount of out-of-sample confirmation
separates the two — because the habit is exactly what persists.`
      : "The top of the ranking does not hold materially more open than the rest, so this particular artifact does not explain the result."}

**What would settle it** is valuing the open positions, which needs market
resolution data. The orderbook subgraph does not carry it, and the sibling
subgraphs that would (\`positions\`, \`pnl\`) return 404. That is the next thing to
solve, and it has to be solved before any of the numbers above mean what they
appear to mean.

## What would make this wrong

- **Closed round trips only.** Positions still open at the end of a window are
  not valued — the subgraph carries no market resolution — so a wallet that
  never closes a loser is flattered. The open share is in \`study.json\` per wallet.
- **Activity sampling.** The universe is wallets that traded often enough to
  appear in a sample of the fill stream. That is the right population (you
  cannot copy someone who does not trade) but it is not all wallets.
- **The subgraph's index stops at 2026-04-27**, so the out-of-sample window is
  about six months, not a year.
- **Trades are treated as independent** in each wallet's p-value. They are not:
  a wallet often holds several outcomes of one market. This makes the p-values
  too confident, which biases toward FINDING an edge, not away from it.

## Reproduce it

\`\`\`
node scripts/polymarket-harvest.mjs --wallets 400
node scripts/polymarket-validate.mjs
\`\`\`
`;
}

main();
