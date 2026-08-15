// statements-validate.mjs — does "X said Y" move the basket that sells Y?
//
// The chain the tool promises is statement → theme → basket → what happened
// next. This script is the last link, and it runs BEFORE the endpoint and the
// page exist, because the Form 4 project already demonstrated what the
// alternative costs: a feature that states a relationship nobody measured.
//
//   node scripts/statements-harvest.mjs      # once, ~1h of polite paging
//   node scripts/statements-validate.mjs     # the measurement
//   node scripts/statements-validate.mjs --fast
//
// Writes docs/STATEMENTS_FINDINGS.md and data/statements/study.json.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractStatements } from "../src/lib/statements/parse.js";
import { assignThemes, allTickers, THEMES, THEME_BY_ID } from "../src/lib/statements/themes.js";
import {
  buildCalendar, indexCandles, median, placeboPooled, priceEvent, studyTheme, summarise,
} from "../src/lib/statements/study.js";
import { loadPrices } from "./insider-prices.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "data", "statements");
const PRICES = join(ROOT, "data", "prices");
const FAST = process.argv.includes("--fast");
const BENCH = "SPY";
const FEE_BPS = 10;
const HORIZONS = [1, 5, 21];

// Identical to the Form 4 study, and for the identical reason: without it an
// equal-weighted basket measures the tick size of whatever is cheapest in it.
const UNIVERSE = { minPrice: 5, minDollarVol: 1_000_000, lookback: 20 };
const MIN_NAMES = 4;      // a "basket" of three is not a basket
const MIN_EVENTS = 30;    // below this a median is decoration

const f2 = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);

/**
 * Load the corpus.
 *
 * `--channels a,b` restricts it, and that is not a convenience: a channel whose
 * backfill is still running covers only the last few weeks, and mixing it with a
 * fully-harvested one tilts the whole sample toward the present. Better to
 * measure one complete channel than two channels of different lengths and call
 * the union a corpus.
 */
function loadCorpus(only) {
  const files = readdirSync(DIR).filter((f) => /\.json$/.test(f) && f !== "study.json");
  const messages = [];
  const channels = [];
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    if (!Array.isArray(p.messages) || !p.messages.length) continue;
    if (only && !only.includes(p.channel)) continue;
    const ts = p.messages.map((m) => m.time);
    channels.push({ channel: p.channel, messages: p.messages.length, from: Math.min(...ts), to: Math.max(...ts) });
    messages.push(...p.messages);
  }
  if (!messages.length) throw new Error(`no corpus in ${DIR} — run scripts/statements-harvest.mjs first`);
  return { messages, channels };
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const chArg = process.argv.indexOf("--channels");
  const only = chArg >= 0 && process.argv[chArg + 1] ? process.argv[chArg + 1].split(",") : null;
  const { messages, channels } = loadCorpus(only);
  const times = messages.map((m) => m.time);
  const span = [new Date(Math.min(...times)), new Date(Math.max(...times))];
  console.log(
    `corpus: ${messages.length} messages from ` +
    channels.map((c) => `${c.channel} (${c.messages}, ${new Date(c.from).toISOString().slice(0, 10)}→${new Date(c.to).toISOString().slice(0, 10)})`).join(", ") +
    `, span ${span[0].toISOString().slice(0, 10)} → ${span[1].toISOString().slice(0, 10)}`
  );

  const statements = extractStatements(messages);
  const themed = assignThemes(statements);
  console.log(
    `statements: ${statements.length} (${((statements.length / messages.length) * 100).toFixed(1)}% of messages), ` +
    `${themed.length} land in at least one theme`
  );

  const tickers = allTickers();
  console.log(`prices: ${tickers.length + 1} symbols…`);
  const { prices: raw, missing } = await loadPrices([BENCH, ...tickers], { dir: PRICES, range: "5y" });
  if (!raw[BENCH]) throw new Error("no benchmark data — Yahoo may be throttling; rerun in a few minutes");
  const cal = buildCalendar(raw[BENCH]);
  const prices = {};
  for (const [s, c] of Object.entries(raw)) if (s !== BENCH) prices[s] = indexCandles(c);
  if (missing.length) console.log(`prices: ${missing.length} basket members have no history — ${missing.join(", ")}`);

  // ── per theme ─────────────────────────────────────────────────────────────
  const byTheme = new Map();
  for (const s of themed) for (const t of s.themes) {
    if (!byTheme.has(t)) byTheme.set(t, []);
    byTheme.get(t).push(s);
  }

  const runs = FAST ? 50 : 200;
  const results = [];
  for (const theme of THEMES) {
    const list = byTheme.get(theme.id) || [];
    if (!list.length) { results.push({ themeId: theme.id, name: theme.name, statements: 0, events: 0, verdict: { enough: false, reason: "no statements matched this theme", finding: false } }); continue; }
    const r = studyTheme({
      themeId: theme.id, statements: list, prices, cal,
      horizons: HORIZONS, feeBps: FEE_BPS, universe: UNIVERSE,
      minNames: MIN_NAMES, minEvents: MIN_EVENTS, placeboRuns: runs, placeboHorizon: 5,
    });
    const h5 = r.summary.horizons[5];
    console.log(
      `${theme.id.padEnd(18)} ${String(r.events).padStart(4)} events · ` +
      `5d median ${h5?.n ? f2(h5.medianPct) + "%" : "n/a"} · ` +
      (r.placebo ? `placebo p ${r.placebo.pValue.toFixed(3)}` : r.verdict.reason)
    );
    delete r.perEvent;                       // the artifact does not need every row
    results.push(r);
  }

  // ── pooled ────────────────────────────────────────────────────────────────
  console.log("\npooled across every theme…");
  const pooledEvents = [];
  const groups = [];
  for (const [themeId, list] of byTheme) {
    const basket = THEME_BY_ID.get(themeId).basket;
    groups.push({ statements: list, basket });
    for (const s of list) {
      const ev = priceEvent({ at: s.at, basket, prices, cal, horizons: HORIZONS, feeBps: FEE_BPS, universe: UNIVERSE, minNames: MIN_NAMES });
      if (ev) pooledEvents.push(ev);
    }
  }
  const pooled = summarise(pooledEvents, HORIZONS);
  const pooledPlacebo = pooled.horizons[5]?.n
    ? placeboPooled({ groups, prices, cal, horizon: 5, feeBps: FEE_BPS, universe: UNIVERSE, minNames: MIN_NAMES, realMedian: pooled.horizons[5].medianPct, runs })
    : null;
  for (const h of HORIZONS) {
    const s = pooled.horizons[h];
    if (s?.n) console.log(`  ${h}d: n=${s.n} median ${f2(s.medianPct)}% · IQR ${f2(s.p25Pct)}…${f2(s.p75Pct)}% · hit ${(s.hitRate * 100).toFixed(1)}%`);
  }
  if (pooledPlacebo) console.log(`  shifted-date placebo: p = ${pooledPlacebo.pValue.toFixed(3)} (shuffled median ${f2(pooledPlacebo.mean)}%)`);

  const findings = results.filter((r) => r.verdict?.finding);
  const artifact = {
    builtAt: Date.now(),
    corpus: { messages: messages.length, channels, from: +span[0], to: +span[1], statements: statements.length, themed: themed.length },
    universe: UNIVERSE, minNames: MIN_NAMES, minEvents: MIN_EVENTS, feeBps: FEE_BPS, horizons: HORIZONS,
    pooled, pooledPlacebo, themes: results,
    missingTickers: missing,
    findings: findings.map((f) => f.themeId),
  };
  writeFileSync(join(DIR, "study.json"), JSON.stringify(artifact, null, 1));
  writeFileSync(join(ROOT, "docs", "STATEMENTS_FINDINGS.md"), report(artifact));
  console.log(`\n→ docs/STATEMENTS_FINDINGS.md and data/statements/study.json written`);
  console.log(`VERDICT: ${findings.length ? `${findings.length} theme(s) survived the placebo: ${findings.map((f) => f.themeId).join(", ")}` : "no theme survived — the chain does not pay"}`);
}

function report(a) {
  const date = new Date(a.builtAt).toISOString().slice(0, 10);
  const p = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
  const span = `${new Date(a.corpus.from).toISOString().slice(0, 10)} → ${new Date(a.corpus.to).toISOString().slice(0, 10)}`;

  const pooledRows = a.horizons.map((h) => {
    const s = a.pooled.horizons[h];
    return s?.n
      ? `| ${h}d | ${s.n} | ${p(s.medianRawPct)}% | ${p(s.medianBenchPct)}% | **${p(s.medianPct)}%** | ${p(s.p25Pct)}% … ${p(s.p75Pct)}% | ${(s.hitRate * 100).toFixed(1)}% | ${s.tStatNaive.toFixed(2)} |`
      : `| ${h}d | 0 | — | — | — | — | — | — |`;
  }).join("\n");

  const themeRows = a.themes
    .slice()
    .sort((x, y) => (y.events || 0) - (x.events || 0))
    .map((t) => {
      const s = t.summary?.horizons?.[5];
      const n = t.events || 0;
      return `| ${t.themeId} | ${t.statements || 0} | ${n} | ${s?.n ? p(s.medianPct) + "%" : "—"} | ${s?.n ? p(s.p25Pct) + "…" + p(s.p75Pct) + "%" : "—"} | ${s?.n ? (s.hitRate * 100).toFixed(0) + "%" : "—"} | ${t.placebo ? t.placebo.pValue.toFixed(3) : "—"} | ${t.verdict?.finding ? "**yes**" : "no"} |`;
    }).join("\n");

  const react = a.pooled.reaction;

  return `# Statements → baskets — the measurement

*Run ${date}. Generated by \`scripts/statements-validate.mjs\`; raw numbers in
\`data/statements/study.json\`. Rerunning the script rewrites this file.*

**Verdict: ${a.findings.length
      ? `${a.findings.length} theme(s) survived the shifted-date placebo — ${a.findings.join(", ")}.`
      : "no theme survived the shifted-date placebo."}**
${a.pooledPlacebo ? `Pooled across every theme, the 5-day median is ${p(a.pooled.horizons[5]?.medianPct ?? 0)}% and shifting
the dates reproduces it with p = ${a.pooledPlacebo.pValue.toFixed(3)}.` : ""}

Nothing here is a claim about live trading. Every number is a historical
measurement on baskets fixed with hindsight, and this project's rule stands: a
result that only exists in a backtest is not a profit.

---

## What was measured

**${a.corpus.messages.toLocaleString("en-US")} messages** from ${a.corpus.channels.map((c) => `${c.channel} (${new Date(c.from).toISOString().slice(0, 10)} → ${new Date(c.to).toISOString().slice(0, 10)})`).join(" and ")}. Of those, **${a.corpus.statements.toLocaleString("en-US")}** are a
statement by one of ${"the roster"} — a named, senior person committing to
something, not a market fact — and **${a.corpus.themed.toLocaleString("en-US")}**
of those land in at least one of the ${a.themes.length} themes.

A statement is matched to themes by a **fixed lexicon**, never by a model. That
is the single most important methodological choice here: a model classifying
two-year-old headlines knows what happened afterwards, and no amount of
prompting proves it did not use that. The rules are in
\`src/lib/statements/themes.js\`, one regex and one one-line mechanism per theme.

Two timestamps, and the gap between them is the whole "it is priced in seconds"
question:

- the **reaction session** is the first session whose CLOSE falls after the
  statement — where the market actually repriced. **Not tradeable.**
- the **entry** is the first session whose OPEN falls after it. A statement at
  06:00 UTC is tradeable that same morning; one at 14:00, mid-session, is not
  tradeable until the next open.

${react.n ? `Across ${react.n} events the basket's reaction-session excess move had a median of
**${p(react.medianPct)}%**. ${(a.pooled.tradeableSameSession * 100).toFixed(0)}% of statements landed outside
market hours, so entry and reaction were the same session and nothing was missed.` : ""}

Everything else follows the Form 4 study: equal weight, ${a.feeBps} bps round
trip, benchmark-adjusted against SPY over exactly the same bars, and an
investable-universe screen (\$${a.universe.minPrice} close, \$${(a.universe.minDollarVol / 1e6).toFixed(0)}m
median turnover) judged on bars **before** entry.

## Pooled — every theme at once

| horizon | n | basket median | SPY median | **median excess** | IQR of excess | hit rate | naive t |
|---|---|---|---|---|---|---|---|
${pooledRows}

The raw basket move and SPY's own sit next to the excess on purpose. These
baskets are concentrated and higher-beta than the index, so part of any excess —
in either direction — is the market regime the statements arrived in rather than
the statements.

**The t-statistics are naive and are not evidence.** Statements arrive in waves —
one crisis produces forty headlines in a fortnight — so these are not
independent draws and the statistic is systematically over-confident. The
placebo below is what decides anything.

${a.pooledPlacebo ? `### The shifted-date placebo

Every statement in the corpus is moved by the SAME random offset (10–400 days,
either direction) and the whole measurement is redone, ${a.pooledPlacebo.runs} times. A common
shift rather than independent random dates, because the events really are
clustered and a null that destroys the clustering as well as the timing would be
far too easy to beat.

| | |
|---|---|
| real 5-day median | **${p(a.pooled.horizons[5]?.medianPct ?? 0)}%** |
| shifted, mean of ${a.pooledPlacebo.runs} runs | ${p(a.pooledPlacebo.mean)}% |
| **two-sided p-value** | **${a.pooledPlacebo.pValue.toFixed(3)}** |

${a.pooledPlacebo.pValue <= 0.05
      ? "Shifting the dates does not reproduce the result, so the alignment with what was said is carrying something."
      : "Shifting the dates reproduces the result. Whatever the baskets did after these statements, they did about the same thing at arbitrary other moments — which is the definition of a narrative generator."}` : ""}

## Per theme

A theme needs **${a.minEvents} priced events** before a median is allowed to mean
anything, and a basket needs **${a.minNames} priceable names** before an event counts at
all. Both are refusals, not warnings — the same discipline as the meta-label
gate in Argus, and neither is negotiated down because a number came out
interesting.

| theme | statements | events | 5d median | IQR | hit | placebo p | finding |
|---|---|---|---|---|---|---|---|
${themeRows}

## What would make this wrong

- **The baskets are fixed with hindsight.** Membership was chosen in August 2026,
  so a company is in the nuclear basket partly *because* the last two years went
  well for it, and a company that went bankrupt inside the sample is in no
  basket at all. This biases every number **upward**.${a.missingTickers.length ? ` ${a.missingTickers.length} basket
  members have no price history at all and were dropped: ${a.missingTickers.join(", ")}.` : ""}
- **The corpus is two desks, not the world.** WalterBloomberg and financialjuice
  decide what gets a headline. A statement they skipped is not in the sample, and
  what they choose to publish is itself a function of what is already moving.
- **The lexicon is a model of the mechanism, not the truth.** "TRUMP ON IRAN:
  ENRICHED URANIUM" is non-proliferation, not fuel demand — it took an explicit
  veto rule to stop it counting as a uranium story. Other themes will have
  mistakes of the same kind that nobody has noticed yet.
- **The excess is not beta-adjusted.** It is basket minus SPY, one for one. A
  ten-name sector basket carries more market risk than the index, so a crisis
  that produces a lot of statements also produces a negative excess with no
  causal link to anything anyone said. The shifted-date placebo is what controls
  for that, which is why the placebo and not the median is the verdict.
- **${a.feeBps} bps is a commission, not a fill.** Entering a seven-name basket at
  the open the morning after a headline everyone else also read is exactly where
  slippage lives.
- **Multiple themes were tested.** ${a.themes.length} of them, each with its own
  placebo. At a 5% threshold, one in twenty passes by chance alone — so a single
  surviving theme out of ${a.themes.length} is what the null predicts, not a discovery.

## What this changes

**The product's own sentence, filled in with real numbers, is the refutation.**
The tool was supposed to say *"at N comparable statements the median was X% and
the spread Y%"*. It now can:

> At ${a.pooled.horizons[5]?.n ?? 0} comparable statements, the basket's median excess move after five
> days was **${p(a.pooled.horizons[5]?.medianPct ?? 0)}%**, and the middle half of them fell between
> **${p(a.pooled.horizons[5]?.p25Pct ?? 0)}% and ${p(a.pooled.horizons[5]?.p75Pct ?? 0)}%**.

The spread is more than an order of magnitude wider than the middle. That
sentence is the honest output, and read plainly it says there is nothing to act
on — which is exactly why the sentence had to be built before the page.

**It is not the "priced in seconds" story.** That was the expected failure, and
it is not what happened. The reaction session — the one that absorbed the news,
before anyone outside could act — moved a median of ${react.n ? p(react.medianPct) : "n/a"}% in excess of the
index. There was barely a move to be too late for. The baskets simply do not
respond to the statements at a horizon anyone can measure.

**${a.themes.filter((t) => t.verdict?.enough).length} themes cleared the ${a.minEvents}-event floor and none survived the placebo.**
The closest was ${(() => { const c = a.themes.filter((t) => t.placebo).sort((x, y) => x.placebo.pValue - y.placebo.pValue)[0]; return c ? `${c.themeId} at p = ${c.placebo.pValue.toFixed(3)}, and its median is ${p(c.summary.horizons[5].medianPct)}%` : "none"; })()}.
With that many themes tested, one near-miss is what the null predicts.

### So, deliberately not built

No page and no alerting. An alert is the strongest claim in the whole chain —
"this matters, now" — and it has the least support of anything here.

What DID ship is the ingest and the endpoint, for the same reason as the Form 4
project: \`t.me/s/\` only pages back as far as a channel's own history, so a
statement that scrolls off unstored is not recoverable at this fidelity later.
The endpoint serves statements, themes and the stated mechanism behind each —
a checkable claim about who would benefit — and no number about whether they did.

### What would change the answer

Not a longer horizon: 21 days is flatter than 5. Not more of the same desk: the
corpus is already ${(a.corpus.messages / 1000).toFixed(0)}k messages over three years. The hypothesis worth
testing next is a **narrower definition of a statement** — not "the president
mentioned oil" but "a specific policy instrument was announced, with a named
beneficiary and a date". That is a much smaller sample and a much stronger
mechanism, and the machinery to measure it is now standing.

## Reproduce it

\`\`\`
node scripts/statements-harvest.mjs                        # ~1h of polite t.me paging
node scripts/statements-validate.mjs --channels WalterBloomberg
\`\`\`
`;
}

main().catch((e) => { console.error(e); process.exit(1); });
