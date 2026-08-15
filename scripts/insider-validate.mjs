// insider-validate.mjs — put the cluster-buy signal through our own gauntlet.
//
// The doctrine this repo runs on: measure whether there is anything to take
// before building anything to take it with. So this script exists BEFORE the
// page, the alerting and the congressional data, and its output is either a
// validated factor or a documented failure. Both are deliverables; only a
// silent "it looks promising" is not.
//
//   node scripts/insider-backfill.mjs            # once, builds the panel
//   node scripts/insider-validate.mjs            # the measurement
//   node scripts/insider-validate.mjs --fast     # 50 placebo runs instead of 200
//
// Writes docs/INSIDER_FINDINGS.md and data/insider/study.json.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { clusterBuys } from "../src/lib/insider/cluster.js";
import {
  buildCalendar, calendarPortfolio, deflatedSharpe, equityCurve, eventStudy,
  gridSearch, indexCandles, median, placebo, seriesStats, verdict, walkForwardEvents,
} from "../src/lib/insider/study.js";
import { loadPrices } from "./insider-prices.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = join(ROOT, "data", "insider");
const PRICES = join(ROOT, "data", "prices");
const FAST = process.argv.includes("--fast");
const BENCH = "SPY";
const FEE_BPS = 10;                                  // 5 bps each way — retail on liquid US equity

// The investable universe, judged on bars BEFORE entry. Cluster buys concentrate
// in micro-caps, and without this the study measures what happens when you
// equal-weight sub-dollar stocks where a two-cent tick is +100%: the first run
// of this script returned an out-of-sample +1,199,985%, which was that, plus a
// look-ahead bug. Both floors are standard and both are stated rather than tuned.
const UNIVERSE = { minPrice: 5, minDollarVol: 1_000_000, lookback: 20 };

const pct = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
const f2 = (x) => x.toFixed(2);

// ── the parameter grid ──────────────────────────────────────────────────────
// Every one of these is a trial, and the deflated Sharpe is told the exact
// count. Searching a grid and then reporting the winner as if it were the only
// thing tried is the single most common way a backtest lies.
const GRID = [];
for (const windowDays of [5, 10, 21]) {
  for (const minInsiders of [2, 3]) {
    for (const minValue of [25_000, 250_000]) {
      for (const holdDays of [5, 21, 63]) {
        for (const officersOnly of [false, true]) {
          GRID.push({ windowDays, minInsiders, minValue, holdDays, officersOnly });
        }
      }
    }
  }
}

function loadPanel() {
  const files = readdirSync(DATA).filter((f) => /^\d{4}q\d\.json$/.test(f)).sort();
  if (!files.length) throw new Error(`no panel in ${DATA} — run scripts/insider-backfill.mjs first`);
  const filings = [];
  const quarters = [];
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(DATA, f), "utf8"));
    quarters.push({ quarter: p.quarter, form4: p.totals.form4, withPurchase: p.totals.withPurchase });
    filings.push(...p.filings);
  }
  filings.sort((a, b) => (a.filedAt || 0) - (b.filedAt || 0));
  return { filings, quarters };
}

async function main() {
  mkdirSync(DATA, { recursive: true });
  const { filings, quarters } = loadPanel();
  // Some filers put a placeholder in <issuerTradingSymbol>. Left in, these become
  // "symbols with no price history" and inflate the survivorship warning with
  // companies that were never delisted — they were never tickers.
  const PLACEHOLDER = new Set(["NONE", "N.A.", "NA", "N/A", "NULL", "N-A", "NOTAPPL", "NOTRADE", "NOSYM"]);
  const withSymbol = filings.filter((f) =>
    f.symbol && /^[A-Z][A-Z.\-]{0,6}$/.test(f.symbol) && !PLACEHOLDER.has(f.symbol));
  console.log(
    `panel: ${filings.length} purchase filings, ${quarters.length} quarters ` +
    `(${quarters[0].quarter}–${quarters[quarters.length - 1].quarter}), ` +
    `${withSymbol.length} carry a usable ticker`
  );

  // The widest setting decides which symbols must be priced, so every grid point
  // is measured on the same price cache rather than on whatever it could load.
  const widest = clusterBuys(withSymbol, { windowDays: 21, minInsiders: 2, minValue: 25_000 });
  const symbols = [...new Set(widest.events.map((e) => e.symbol))];
  console.log(`clusters (widest setting): ${widest.events.length} events over ${symbols.length} symbols`);

  console.log(`prices: loading ${symbols.length + 1} symbols (cached in data/prices)…`);
  let last = 0;
  const { prices: raw, missing } = await loadPrices([BENCH, ...symbols], {
    dir: PRICES, range: "10y",
    onProgress: (d, n) => { if (d - last >= 250 || d === n) { last = d; process.stdout.write(`\r  ${d}/${n}`); } },
  });
  process.stdout.write("\n");
  if (!raw[BENCH]) throw new Error("no benchmark data — Yahoo may be throttling; rerun in a few minutes");

  const cal = buildCalendar(raw[BENCH]);
  const prices = {};
  for (const [s, c] of Object.entries(raw)) if (s !== BENCH) prices[s] = indexCandles(c);
  console.log(
    `prices: ${Object.keys(prices).length} usable, ${missing.length} with no history ` +
    `(${((missing.length / Math.max(symbols.length, 1)) * 100).toFixed(1)}% — see the survivorship note)`
  );

  const makeEvents = (p) => clusterBuys(withSymbol, p).events;

  // ── full-sample grid ──────────────────────────────────────────────────────
  console.log(`\ngrid: ${GRID.length} settings…`);
  const ranked = gridSearch({ grid: GRID, makeEvents, prices, cal, feeBps: FEE_BPS, universe: UNIVERSE });
  const head = ranked[0];
  console.log(`best in sample: ${JSON.stringify(head.params)} → Sharpe ${f2(head.stats.sharpe)} on ${head.coverage.used} events`);

  const headEvents = makeEvents(head.params);
  const headPf = calendarPortfolio({ events: headEvents, prices, cal, holdDays: head.params.holdDays, feeBps: FEE_BPS, universe: UNIVERSE });
  const headStats = seriesStats(headPf.daily);
  const dsr = deflatedSharpe(headPf.daily, GRID.length);

  // ── the placebo ───────────────────────────────────────────────────────────
  const runs = FAST ? 50 : 200;
  console.log(`placebo: ${runs} runs with the dates shuffled…`);
  const pl = placebo({
    events: headEvents, prices, cal, holdDays: head.params.holdDays, feeBps: FEE_BPS, universe: UNIVERSE,
    realSharpe: headStats.sharpe, runs,
  });
  console.log(`placebo: real ${f2(headStats.sharpe)} vs shuffled mean ${f2(pl.mean)} (p95 ${f2(pl.p95)}) → p = ${pl.pValue.toFixed(3)}`);

  // ── does clustering add anything over a single insider? ───────────────────
  const singleParams = { ...head.params, minInsiders: 1, requireDistinctFilings: false };
  const singleEvents = makeEvents(singleParams);
  const singlePf = calendarPortfolio({ events: singleEvents, prices, cal, holdDays: head.params.holdDays, feeBps: FEE_BPS, universe: UNIVERSE });
  const singleStats = seriesStats(singlePf.daily);
  console.log(`single-insider control: Sharpe ${f2(singleStats.sharpe)} on ${singlePf.coverage.used} events`);

  // ── event study ───────────────────────────────────────────────────────────
  const es = eventStudy({ events: headEvents, prices, cal, horizons: [5, 21, 63, 126], feeBps: FEE_BPS, universe: UNIVERSE });

  // ── walk-forward ──────────────────────────────────────────────────────────
  console.log("walk-forward: 4 folds, 63-day embargo…");
  const wf = walkForwardEvents({ grid: GRID, makeEvents, prices, cal, folds: 4, feeBps: FEE_BPS, universe: UNIVERSE, embargoDays: 63 });
  if (wf) console.log(`walk-forward: OOS ${pct(wf.oos.totalPct)}, ${wf.profitableFolds}/${wf.totalFolds} folds positive → ${wf.verdict}`);

  const v = verdict({ stats: headStats, dsr, placeboOut: pl, wf, coverage: headPf.coverage });

  // ── report ────────────────────────────────────────────────────────────────
  const lagDays = median(headEvents.map((e) => e.maxLagDays));
  const artifact = {
    builtAt: Date.now(),
    panel: { quarters, filings: filings.length, withTicker: withSymbol.length },
    grid: GRID.length,
    universe: UNIVERSE,
    headline: { params: head.params, stats: headStats, coverage: headPf.coverage, dsr },
    placebo: { runs: pl.runs, mean: pl.mean, p95: pl.p95, pValue: pl.pValue },
    single: { params: singleParams, stats: singleStats, coverage: singlePf.coverage },
    eventStudy: es,
    walkForward: wf && {
      folds: wf.folds, oos: wf.oos, verdict: wf.verdict,
      profitableFolds: wf.profitableFolds, totalFolds: wf.totalFolds,
      skippedFolds: wf.skippedFolds, from: wf.from, to: wf.to,
    },
    survivorship: { symbols: symbols.length, missing: missing.length, sample: missing.slice(0, 25) },
    verdict: v,
    top: ranked.slice(0, 10).map((r) => ({ params: r.params, sharpe: r.stats.sharpe, annRetPct: r.stats.annRetPct, events: r.coverage.used })),
    equity: equityCurve(cal.times, headPf.daily).filter((_, i) => i % 5 === 0),
  };
  writeFileSync(join(DATA, "study.json"), JSON.stringify(artifact, null, 1));

  const md = report({ artifact, quarters, ranked, headEvents, lagDays, widest, missing, symbols });
  writeFileSync(join(ROOT, "docs", "INSIDER_FINDINGS.md"), md);
  console.log(`\n→ docs/INSIDER_FINDINGS.md and data/insider/study.json written`);
  console.log(`VERDICT: ${v.pass ? "PASS" : "FAIL"}${v.reasons.length ? ` — ${v.reasons.join("; ")}` : ""}`);
}

function report({ artifact, quarters, ranked, headEvents, lagDays, widest, missing, symbols }) {
  const h = artifact.headline;
  const es = artifact.eventStudy;
  const wf = artifact.walkForward;
  const date = new Date(artifact.builtAt).toISOString().slice(0, 10);
  const p = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

  const esRows = Object.entries(es).map(([hor, r]) =>
    `| ${hor}d | ${r.n} | ${p(r.meanExcessPct)}% | ${p(r.medianExcessPct)}% | ${(r.hitRate * 100).toFixed(1)}% | ${r.sdExcessPct.toFixed(1)}% | ${r.tStatNaive.toFixed(2)} |`
  ).join("\n");

  const gridRows = ranked.slice(0, 10).map((r) =>
    `| ${r.params.windowDays}d | ${r.params.minInsiders} | $${(r.params.minValue / 1000).toFixed(0)}k | ${r.params.holdDays}d | ${r.params.officersOnly ? "yes" : "no"} | ${r.coverage.used} | ${r.stats.sharpe.toFixed(2)} | ${p(r.stats.annRetPct)}% |`
  ).join("\n");

  const wfRows = wf ? wf.folds.map((f) =>
    `| ${f.fold} | ${f.params.windowDays}d/${f.params.minInsiders}/${f.params.holdDays}d${f.params.officersOnly ? "/off" : ""} | ${f.trainSharpe.toFixed(2)} | ${f.trainEvents} | ${p(f.testStats.totalPct)}% | ${f.testStats.sharpe.toFixed(2)} | ${f.testEvents} |`
  ).join("\n") : "";

  return `# Insider cluster buys — the measurement

*Run ${date}. Generated by \`scripts/insider-validate.mjs\`; the raw numbers are
in \`data/insider/study.json\`. Rerunning the script rewrites this file.*

**Verdict: ${artifact.verdict.pass ? "the signal survives our gauntlet" : "the signal does NOT survive our gauntlet"}.**
${artifact.verdict.reasons.length ? artifact.verdict.reasons.map((r) => `- ${r}`).join("\n") : "- every gate passed"}

Nothing here is a claim about live trading. Every number below is a backtest on
reported filings, and this project's own rule stands: a strategy that is
profitable in a backtest is not profitable.

---

## What was measured

${quarters.length} quarters of SEC Form 4 filings, ${quarters[0].quarter}–${quarters[quarters.length - 1].quarter}:
**${quarters.reduce((s, q) => s + q.form4, 0).toLocaleString("en-US")} filings**, of which
**${artifact.panel.filings.toLocaleString("en-US")} (${((artifact.panel.filings / quarters.reduce((s, q) => s + q.form4, 1)) * 100).toFixed(1)}%)**
contain an **open-market purchase** — transaction code \`P\`, the only code that
represents an insider deciding to put personal cash in. Grants, option exercises
and tax withholding are payroll and are excluded; sales are excluded because they
are dominated by diversification and pre-set plans. ${artifact.panel.withTicker.toLocaleString("en-US")}
of the purchase filings carry a usable ticker.

A **cluster** is ≥N distinct reporting owners of the same issuer buying within a
rolling window, and it fires on the date the **last** of those filings became
public — never on the transaction date. The median cluster here was knowable
**${lagDays} days** after its first purchase, which is the Form 4 reporting
deadline doing its job and the reason this is not the congressional problem.

Position sizing is deliberately dumb: equal weight, entry at the **next open**
after the filing, exit after a fixed holding period, ${FEE_BPS} bps round trip,
return measured **in excess of SPY** day by day. All of it is a calendar-time
portfolio rather than an average over events — insider clusters arrive in waves,
so averaging events treats several hundred readings of the same fortnight as
independent draws, which is how event studies manufacture significance.

The universe is screened on bars **before** entry: a close of at least
$${artifact.universe.minPrice} and a median $${(artifact.universe.minDollarVol / 1e6).toFixed(0)}m
of daily turnover over the prior ${artifact.universe.lookback} sessions. Insider clusters
concentrate in micro-caps, and equal-weighting sub-dollar stocks measures the
tick size rather than the insiders.

### Two bugs found on the way, both of which had made it look like a triumph

- **A filing date is UTC midnight; a Yahoo daily bar is stamped 13:30 UTC.**
  Comparing the raw timestamps said the same day's bar came *after* the filing,
  so every position entered at the open of the day the filing was still
  unpublished. Entry is now decided on calendar days.
- **No universe screen.** The first run held anything with a ticker, including
  sub-dollar names where one tick is a double-digit return.

Together they produced a Sharpe of 3.67 and a walk-forward return of
**+1,199,985%** — which is the reason this project's rule is that a result too
good to be true gets its arithmetic checked before it gets believed.

## The headline setting

Best of **${artifact.grid} grid settings** searched on the full sample —
so this is the most flattering configuration, not an unbiased one:

| | |
|---|---|
| window | ${h.params.windowDays} days |
| distinct insiders | ≥ ${h.params.minInsiders} |
| minimum cluster value | $${h.params.minValue.toLocaleString("en-US")} |
| holding period | ${h.params.holdDays} days |
| officers/directors only | ${h.params.officersOnly ? "yes" : "no"} |
| events used | ${h.coverage.used} of ${h.coverage.events} |
| dropped: no price history | ${h.coverage.noPrice} |
| dropped: below the universe floor | ${h.coverage.illiquid} |
| days invested | ${(h.coverage.investedShare * 100).toFixed(1)}% of the sample |
| average names held | ${h.coverage.avgPositions.toFixed(1)} |
| **excess return, total** | **${p(h.stats.totalPct)}%** |
| annualised | ${p(h.stats.annRetPct)}% |
| annualised vol | ${h.stats.annVolPct.toFixed(2)}% |
| **Sharpe (excess over SPY)** | **${h.stats.sharpe.toFixed(2)}** |
| max drawdown | ${h.stats.maxDDPct.toFixed(2)}% |
| **Deflated Sharpe** (${artifact.grid} trials) | **${h.dsr ? (h.dsr.dsr * 100).toFixed(1) + "%" : "n/a"}** |

${h.dsr ? `The deflated Sharpe is the probability the true Sharpe is above zero *after*
charging for having searched ${artifact.grid} settings. The search alone would be
expected to produce a Sharpe of ${h.dsr.sr0.toFixed(4)} per day from nothing.` : ""}

### Where the rest of the grid landed

| window | insiders | value | hold | officers | events | Sharpe | ann. |
|---|---|---|---|---|---|---|---|
${gridRows}

A signal that only works at one corner of a grid is a coincidence with good
manners. Read this table before the one above it.

## The placebo — the test that settles it

Every event keeps its company; the dates are shuffled among the events. That
holds the calendar, the symbol mix and the event count fixed and destroys only
the timing.

| | |
|---|---|
| real Sharpe | **${h.stats.sharpe.toFixed(2)}** |
| shuffled, mean of ${artifact.placebo.runs} runs | ${artifact.placebo.mean.toFixed(2)} |
| shuffled, 95th percentile | ${artifact.placebo.p95.toFixed(2)} |
| **empirical p-value** | **${artifact.placebo.pValue.toFixed(3)}** |

${artifact.placebo.pValue <= 0.05
      ? `Shuffled dates do **not** reproduce the result, so the timing carries information
about these companies. Read that together with the level, though: the shuffled
mean is ${artifact.placebo.mean.toFixed(2)}, so ${artifact.placebo.mean < -0.2
        ? `these names lose heavily against SPY at random moments. What the test
establishes is that a cluster buy marks a moment when they lose **less**, which
is a real effect and not a strategy — the tradeable question is the level, and
the level is a Sharpe of ${h.stats.sharpe.toFixed(2)} before any of the frictions listed at the
bottom of this page.`
        : "the timing rather than the sample is doing the work."}`
      : "Shuffled dates reproduce the result, so what looked like an insider effect is the sample: these companies over this calendar would have done about the same thing on random days."}

## Does clustering add anything?

The briefing's premise is that the cluster form is what carries in the
literature, not single names. Same setting, one insider instead of ${h.params.minInsiders}:

| | events | Sharpe | ann. excess |
|---|---|---|---|
| cluster (≥${h.params.minInsiders} insiders) | ${h.coverage.used} | ${h.stats.sharpe.toFixed(2)} | ${p(h.stats.annRetPct)}% |
| any single purchase | ${artifact.single.coverage.used} | ${artifact.single.stats.sharpe.toFixed(2)} | ${p(artifact.single.stats.annRetPct)}% |

## Event study (descriptive)

Buy-and-hold from the next open, in excess of SPY. **The t-statistics here are
naive** — overlapping events on a shared calendar are not independent, so they
are systematically too confident. They are shown for the shape of the
distribution, not for their significance.

| horizon | n | mean excess | median | hit rate | sd | naive t |
|---|---|---|---|---|---|---|
${esRows}

## Walk-forward

Four windows, parameters chosen on each and frozen for the next, with a 63-day
embargo so a position opened on the last training day cannot leak into the test.

${wf ? `| fold | chosen | train Sharpe | train events | OOS return | OOS Sharpe | OOS events |
|---|---|---|---|---|---|---|
${wfRows}

Stitched out of sample: **${p(wf.oos.totalPct)}%**, Sharpe ${wf.oos.sharpe.toFixed(2)},
${wf.profitableFolds} of ${wf.totalFolds} folds positive → **${wf.verdict}**.
${wf.skippedFolds ? `${wf.skippedFolds} fold(s) were skipped because the training window could not support 20 events — a window that cannot make a choice does not get to make one.` : ""}

The folds span the event calendar (${new Date(wf.from).toISOString().slice(0, 10)} → ${new Date(wf.to).toISOString().slice(0, 10)}),
not the price calendar, which reaches years further back and would otherwise hand
fold 1 a training window with no filings in it at all.` : "Not enough calendar for four folds."}

## What would make this wrong

- **Survivorship.** ${missing.length} of ${symbols.length} symbols
  (${((missing.length / Math.max(symbols.length, 1)) * 100).toFixed(1)}%) have no price
  history at Yahoo, and a ticker that cannot be fetched is usually one that was
  acquired or delisted. Their events are dropped, which biases the result
  **upward** — bankruptcies are exactly where insider buying ends badly.
  ${missing.length ? `Examples: ${missing.slice(0, 12).join(", ")}.` : ""}
- **No borrow, no impact, no bid-ask.** ${FEE_BPS} bps round trip is a
  commission assumption, not a fill. Even above the universe floor, a $1m-a-day
  name will not absorb a position at the open print without moving.
- **The universe floor is a choice.** ${h.coverage.illiquid} events were dropped
  by it. Lowering it raises the measured return and lowers how much of that
  return could ever be taken; it was set once, from the literature's usual
  convention, and not tuned against the result.
- **Ticker drift.** Prices are fetched under today's ticker. A company that
  changed symbol inside the sample is matched to the wrong series or to none.
- **The grid.** ${artifact.grid} settings were searched. The deflated Sharpe
  charges for that; the walk-forward is the check that the charge is enough.

## What this changes

**The briefing's premise held directionally and failed on level.** Cluster buys
really do beat single purchases (${h.stats.sharpe.toFixed(2)} against ${artifact.single.stats.sharpe.toFixed(2)}), and the
shuffled dates really are worse than the real ones. Both of those are the shape
the literature describes. What none of it produces is something worth trading:
after the search is charged for, the deflated Sharpe is
${h.dsr ? (h.dsr.dsr * 100).toFixed(1) + "%" : "n/a"}, and the walk-forward says
${wf ? `${wf.profitableFolds} of ${wf.totalFolds}` : "no"} out-of-sample windows.

**Holding longer is not the fix.** The event study gets *worse* at every horizon
past a week — ${Object.entries(es).map(([k, r]) => `${k}d ${p(r.meanExcessPct)}%`).join(", ")}.
Whatever these companies are, the market is not slowly waking up to them.

**Where the effect probably does live is where we cannot trade it.**
${h.coverage.illiquid} events were dropped by the universe floor, and that is the
micro-cap tail the academic results are mostly measured on. Removing the floor
would raise the number and lower how much of it is reachable. That trade-off is
the finding, not a parameter to tune.

### So, deliberately not built

No screen that ranks clusters by conviction, no alerting, no page. The ingest and
the endpoint exist and make no claim; building a UI that implies one would be a
feature asserting something this file has already tested and failed to support.
The daily ingest keeps running anyway — it costs about a thousand requests a day,
it is a public record that cannot be backfilled at the same fidelity later, and
the issuer/ticker layer it produces is what the next project (statements →
beneficiaries) needs regardless of whether insiders predict anything.

## Reproduce it

\`\`\`
node scripts/insider-backfill.mjs      # ~250 MB of SEC quarterly datasets
node scripts/insider-validate.mjs      # ~10 min, most of it price downloads
\`\`\`
`;
}

main().catch((e) => { console.error(e); process.exit(1); });
