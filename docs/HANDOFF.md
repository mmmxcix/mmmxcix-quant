# Handoff — 13 August 2026

State of the three agents, what changed in the last session, what is open, and
the queue of things you asked for that did not fit.

Written because the previous chat ran out of room. Everything here is either in
the repo or live; nothing depends on that conversation.

---

## Start here

Three agents run on the PC and report to the site. All are **paper only**.

| Agent | What it is | Where | Health |
|---|---|---|---|
| **Argus** | 24/7 day-trader, technical + event channel | `/argus` | 7,595 of 10,000 — losing, heavily instrumented, see below |
| **Kronos** | Pretrained candlestick model, forecasts 24h ahead | `/arena` | 10,000 of 10,000, waiting for its first horizons |
| **Arena** | Live paper trading for order-book strategies | `/arena` | Running; micro-price measured, **no edge found** |

They are launched by `scripts/agent-daemon.mjs`, which starts from the Windows
Startup folder (`agent-daemon.vbs`). It forks its children, so nothing ever
creates a console window.

```
gaming-mode.cmd            double-click to stop/start the whole fleet
npm run gaming:status      what is running, and whether the GPU is busy
```

The same switch exists on `/arena` for the dev account only. Local and web stay
in sync: whoever decided more recently wins.

---

## Argus — the honest position

**It does not have a demonstrated edge.** 98 closed trades, 28.7% wins,
−0.25R average. The last full analysis is the post-mortem artifact; the short
version is that the loss had two causes, both fixed, and neither of them creates
an edge:

- The **reward:risk floor was 0.8**, which needs a 55.6% win rate to break even.
  Now 1.5 (`MIN_PLANNED_R` in `src/lib/argus/core.js`).
- The **skip rule needed 25 trades**, so `orb` (0 of 9) and `vwap-band` (0 of 4)
  — 67% of the entire loss from 13 trades — could never be switched off. Now 8
  for skipping, 20 still required for resizing.

**26 of 28 lessons in that ledger are negative.** Only two things earned:
liquidity-sweep SHORTS and the London session. Slicing a losing book by any
dimension produces losing buckets, and the learning loop can only decide what to
switch off — it cannot manufacture what was never there.

### What was built to find out more

Everything below exists so the next hundred trades produce answers the last
hundred could not.

| Module | What it answers |
|---|---|
| `argus/core.js` → `breakEvenStudy` | Would a break-even stop have helped? Needs the new excursion timestamps, so it only works on trades from now on. |
| `argus/metalabel.js` | Should we act on this signal? **Currently refuses**: 22 outcomes of the rarer class, 100 needed. ~272 more trades. |
| `argus/walkforward.js` | Does the learning loop actually learn? **Yes** — out of sample it keeps −0.197R and refuses −0.526R. Real work on a book that still loses. |
| `argus/explore.js` | A quarter of the daily budget probes the *least settled* refusals, so the loop cannot talk itself silent. |
| `argus/pace.js` | 4 concurrent positions, 12 new trades per day. The book was doing 59/day with 9 open. |
| `scripts/argus-halflife.mjs` | What half-life should the learning loop forget at? **Currently inconclusive** and says so. |

### Env vars added

```
LAB_ARGUS_MAX_CONCURRENT=4     0 disables
LAB_ARGUS_MAX_PER_DAY=12       0 disables
LAB_ARGUS_HALFLIFE_H=0         recency weighting, OFF — see below
```

---

## The three findings of mine that did not survive measurement

Recorded because they are the reason to distrust a confident-sounding analysis,
including the next one.

1. **"Portfolio heat 8% is fiction."** Wrong. Heat is the *sum* of stop-risk —
   the all-stop-out worst case, not an optimistic estimate — and correlation
   already tightened the cap to exactly the 12% observed. The real gap was
   narrower: direction was ignored, so long+long and long+short scored the same.
   Fixed.

2. **"80% of stops sit on the noise floor."** Wrong, and acting on it would have
   hurt. Median stop is **2.35 ATR**, tightest 1.13, and performance got *worse*
   as stops widened. What the measurement did expose: the volatility ceiling is
   quoted per daily bar and was compared against a 5-minute ATR — 12× too high,
   so the gate had **never fired once**. Now scaled by the square root of time.

3. **The arena scoreboard's first live reading.** The micro-price looked 35%
   better than the mid — from an adjustment of at most 0.3 ticks. The arithmetic
   not working is what gave it away: mid was averaged over every sample since
   start-up, micro only over the shorter, calmer window since its model existed.
   Fixed; the honest result is below.

---

## Arena — the micro-price does not pay for itself

After both bugs were fixed, over 35,600 **common** samples:

| Market | Mid | Weighted mid | Micro-price |
|---|---|---|---|
| BTCUSDT | 577.5 | **577.4** | 577.4 (−0.01% vs mid) |
| ETHUSDT | 22.41 | 22.31 | **22.27** (−0.63% vs mid) |

Essentially indistinguishable, and on BTC the micro-price is *worse* than the
weighted mid. The estimator is implemented from the paper and verified against
simulated markets where it works — it simply does not earn its complexity at
this horizon on these markets. That is the arena doing its job, and no backtest
could have said it.

Two bugs were found on the way, both worth remembering:

- The model was **never being built**. A fixed 8×3 grid, on a market that quotes
  a one-tick spread 99% of the time: two thirds of the states could never fill,
  coverage stuck at 33%. `suggestGrid()` now reads the spread depth from the data.
- A taker micro-price strategy is **impossible at retail fees**. 0.1% taker is
  ~$200 per round trip on BTC while the spread is one cent. The first agent
  correctly opened zero positions. It is a market-*making* signal.

---

## Kronos

Runs at 01:00 and 13:00 on the GPU, skipping the forecast (but still grading) if
the card is busy. 10,000 USDT paper, 1% risk, 1.5% stop, only trades a forecast
above 1%. Every decision is journalled **including the refusals** — the first
live run passed on both markets and says why.

Setup that is easy to get wrong again:

- torch **2.11.0+cu128**. The RTX 5080 is Blackwell (sm_120); cu124 wheels have
  no kernels for it.
- The Kronos package is a **git checkout** at `GitHub/Kronos` (MIT), not a wheel.
- Python's default User-Agent gets a **403 from Cloudflare**, which looks exactly
  like an auth failure.

---

## Open

1. **Wait.** The instrumentation is dense enough that the next hundred trades
   answer questions the last hundred could not. Further tuning before then is
   fitting noise.
2. **The break-even hypothesis** — 22 of 68 losers were up ≥0.5R before dying.
   Now measurable, needs new trades.
3. **The half-life** — `node scripts/argus-halflife.mjs` once the ledger spans
   weeks rather than days.
4. **Meta-labelling** — ~272 more trades before it will produce a model.

---

## Cortex — why it finds nothing (measured 13 Aug)

**It does read real research.** arXiv, SSRN, OpenAlex, Crossref, Zenodo — genuine
academic venues, plus blogs, HN and YouTube. Not just people posting where they
are.

**But it only ever sees the abstracts.** `fullTextOf()` in `scripts/sources.mjs`
can only upgrade two things: an arXiv HTML rendering, and a YouTube transcript.
For SSRN, OpenAlex, Crossref and Zenodo — which is where the finance papers
actually are — it returns `""` and the caller falls back to the abstract.
Verified empirically: all five paper sources return no body text. The dashboard
agrees: **full text on 0%**.

The file's own comment already says why this matters: *"the abstract says an
effect exists, the body says how it was measured — lookback, rebalance,
universe, thresholds."* Cortex is being asked to build a testable strategy from
a paragraph that says momentum predicts returns, and has to invent every
parameter. That is the most likely reason nothing survives the gauntlet.

("arXiv 0" in the harvest line is NOT a bug — the API returns 8 fine. q-fin
publishes few papers a day and the seen-filter removes repeats.)

### The four levers, in order

1. **Get the body text.** OpenAlex already returns `best_oa_location.pdf_url`
   for open-access work; SSRN and Zenodo have predictable PDF URLs. Needs a PDF
   text extractor. This is the single biggest quality lever in the pipeline and
   the code says so itself.
2. **Check the structural mismatch first.** Most academic equity strategies are
   CROSS-SECTIONAL — rank a universe, long the top decile, short the bottom.
   `runBacktest({ candles, signalFn })` is single-instrument time-series. A
   momentum paper's result *cannot* be reproduced on one symbol, so faithfully
   implementing it and then failing the gauntlet is the expected outcome, not a
   discovery. Worth confirming before building anything else.
3. **Refuse rather than guess.** Same discipline as the meta-label gate: extract
   a reproduction checklist from the paper (universe, period, rebalance,
   lookback, cost assumption) and if it cannot be filled, do not generate a
   strategy at all.
4. **Search for mechanisms, not for the phrase.** The queries are
   `"trading strategy"`, which is what every paper writes. Named effects
   ("post-earnings announcement drift", "time-series momentum", "variance risk
   premium", "betting against beta") retrieve far better.

---

## The five videos — watched 13 August, verdicts

All five are done. One idea per video survives; the rest is marketing.

**1 · `Db8cna4MpOu` — Matteo Conti, 25s.** A reply to a commenter who called
50-year-old research obsolete. His answer: statistical arbitrage has run at hedge
funds since the 70s, was published in 1990 (he holds up Lehmann, *Fads,
Martingales, and Market Efficiency*, QJE Feb 1990), is still the most common
strategy in the industry, "and your ability is in identifying **on which
instruments** you should apply it to."

That last clause is the whole video. We own the machinery — `src/lib/pairs.js`
has OLS + Kalman hedge ratios and an OU half-life, and correctly rejects
non-cointegrating pairs — but it is wired into exactly one place, the
Correlation page, as a two-symbol widget. **There is no screener that ranks a
universe by tradeability.** That is the selection layer he says the edge lives
in, and it is the one thing we have built the parts for and never assembled.

**2 · `Db5b-JJzNgJ` — carry trading, 2:10.** Day 3 of a series (1 mean
reversion, 2 momentum, 4 will be stat-arb, "mean reversion industrialised").
Carry = get paid for holding: borrow low-rate currency, buy high-rate; bond term
premium; the shape of the futures curve; selling options premium. One structure
in four costumes. It should not work — the high-rate currency ought to fall by
the rate gap — and it does anyway because you are **underwriting risk, not
collecting free money**. Insurance pays until the disaster.

The useful part is his closing taxonomy, because it is a portfolio-construction
rule rather than a strategy:

| Family | Payoff shape |
|---|---|
| Mean reversion | wins often, small |
| Momentum | loses often, wins big |
| Carry | wins daily until a rare collapse |

Firms hold all three *because* the shapes differ. Our registry ranks strategies
against each other on one axis (score) and has no notion of which shape a
strategy is, so it cannot select for complementarity — it can only select for
whoever is winning. We also have **no carry sleeve at all**; crypto perpetual
funding is the accessible version and we already have the venues.

Caveat worth writing down: carry is a short-volatility payoff, so it looks
excellent in-sample and our quality gates (mandatory stop, `MIN_PLANNED_R` 1.5)
structurally forbid its shape. A carry engine is a separate engine, not a
strategy to drop into Argus.

**3 · `Db2C1rclLV9` — seb.ai's "24/7 AI market scanner", 8-slide carousel.**
Same account as the AI-hedge-fund PDF. Architecture, verbatim:
`SCAN → FILTER → RESEARCH → SCORE → RISK → ALERT`. Scan price/volume/momentum/
volatility/news; filter on liquidity, volume, trend, volatility, own rules;
research across news, price action, financials, sentiment, catalysts; score;
risk gate with pass/reject; push alert. Then a human decides — it never trades.

**Argus is the same pipeline and is further along at every stage:**

| His stage | Ours |
|---|---|
| SCAN | `argus/scanners.js` |
| FILTER | `volStatus`, rvol, liquidity, the vol ceiling |
| RESEARCH | `argus/llm.js` + the event channel |
| SCORE | one `conviction` number |
| RISK | `openThesis` — heat, correlation, leverage, min planned R |
| ALERT | `argus/notify.js` — and then it actually takes the trade |
| — | `learn.js`, `walkforward.js`, `metalabel.js`, `explore.js` (he has none) |

One thing is genuinely worth taking, and it is not the pretty card. He stores
**five component scores** (trend 8.4, momentum 7.9, volume 9.1, catalyst 7.2,
risk 6.8 → 82/100) where we collapse everything into one conviction plus
pass/fail `riskChecks`. Component scores are *continuous features recorded per
trade*. `metalabel.js` has ten features today and none of them describe why we
liked the setup. Recording five more changes no decision, costs nothing at
entry, and makes the next hundred trades answer more than they otherwise could.
It is the only Argus change that gets **worse by waiting**, because every trade
that closes without them is a row the model can never use.

**4 · `DYqhTtMxfqZ` — OSIRIS, 15s, no narration.** "Open source Palantir",
dropped on reddit. Real: `github.com/simplifaisoul/osiris`, **MIT**, ~7.6k stars,
Next.js 16 + MapLibre GL, Docker or Vercel, most feeds keyless. Sixteen layers:
OpenSky aviation, maritime via **aisstream — the same key we use**, public
traffic CCTV (TfL/WSDOT/Caltrans/NZTA…), USGS quakes, NASA FIRMS, NASA EONET,
NOAA SWPC, N2YO satellites, 25+ live news streams, Telegram OSINT via
`t.me/s/<channel>`, OpenSanctions/OFAC, crypto tracing, GPS jamming — plus a
recon toolkit (nmap, DNS, WHOIS, certs) that is irrelevant to trading and would
be a liability if ever exposed publicly.

This is the worldmonitor.app design target again, except **MIT instead of
AGPL-3.0** — so for the first time we may read the implementation rather than
only the idea. Our map already has most of these layers; what OSIRIS has and we
do not is the **Telegram-OSINT ingest**, which the July analysis already
identified as the single biggest news-speed win. Now there is a readable MIT
implementation of it.

Caution: many byte-identical clone repos exist, one with a Solana pump-token
address in its description. Use the canonical repo, read before running, do not
`docker run` it blind.

**5 · `Dbwck6nt3ax` — Nebula, 7s, music only.** Already reviewed on 23 July:
orionrfx's no-code MT4/5 strategy engine, £79/£159, runs on the user's PC, "only
runs what survives OOS". Verdict then and now: narrower than us, nothing
structurally missing on our side, its pricing validates our paywall range. The
clip adds only UI — a batch "Mission Control" with live progress and a ranked
leaderboard of named candidates (each with score, trade count, equity sparkline)
and a per-strategy "Forward Confidence" panel. We have all of that in substance;
the leaderboard-with-sparklines presentation is a minor idea for the Registry.

### What came out of it — all five built, 13 August

**1 · The Argus setup scorecard** (video 3) — `src/lib/argus/scorecard.js`. Five
components recorded at entry (trend, momentum, volume, catalyst, risk; 0–10 each,
5 = neutral, unknown scores 5 and never 0), written onto the thesis by
`argus-agent.mjs` and shown on `/argus` labelled *recorded, not applied*.

**No decision changed.** Every gate still decides exactly as it did; the
scorecard is computed after they have all said yes. Two supporting changes:

- `scan()` now also measures the last hour's move in ATR units (`momAtr`).
  Nothing gates on it.
- **A retest fill used to reach the ledger undescribable.** The parked-limit path
  rebuilt the setup without `atrPct`/`rvol`, so `riskChecks.volatility` read
  "n/a" — and `metalabel.featuresOf` correctly refuses such a row. Every
  limit-filled trade was a row no model could ever use. The readings taken when
  the setup was found are now carried through for the record; the gates still
  read the live fields, so the decision is untouched.

`metalabel.js` gained `FEATURES_EXT` (the ten old features plus the five scores)
and `chooseFeatures()`, which uses the wider set **only** once the trades that
carry scores can support it on their own — 150 of the rarer class instead of 100.
Until then the scores are recorded and unused. The sample rule is not negotiated
down because the new columns are interesting.

**2 · The pairs screener** (video 1) — `src/lib/pairsScreen.js`, on
`/tools/correlation` under the single-pair panel. Ranks every pair in the basket,
and refuses to be a data-mining machine while doing it: an Engle–Granger ADF
statistic (β was *estimated*, so plain ADF values are far too generous), the
p-value doubled because both directions were tried, then Benjamini–Hochberg
across all pairs — plus the footnote saying how many survivors the null alone
would produce. A pair is only "tradeable" if it also reverts inside a usable
half-life band and its 2σ swing covers the round-trip cost. On a universe of pure
random walks it returns nothing, which is the test that matters.

**3 · Payoff shapes** (video 2) — `src/lib/payoff.js`, on `/cortex/registry`.
The family is **inferred, never declared**: profit factor and win rate already
contain the average win/loss ratio (`PF·(1−w)/w`), so every card now shows its
shape, its win/loss ratio and the ratio it must clear to break even — the
arithmetic that quietly bankrupted Argus, shown before it does it again. Below
20 trades the shape is withheld as unreadable. A library that is all one shape
gets told so, and `selectComplementary()` orders a set by what each pick *adds*
(own Sharpe − correlation to the set + credit for a missing shape). Ordering
only: fitting weights to backtested correlations is the most overfittable object
in the tool.

**4 · Telegram OSINT** (video 4) — **was already built**, and is better than
OSIRIS's: `/api/telegram` serves the keyless `t.me/s/` scrape, `telegram-mtproto.mjs`
pushes the richer MTProto read on top, Argus's event brief consumes it, and
`geoNews.js` already pins OSINT items on the world map. Verified live. The one
real gap is closed: the MTProto poller is now started by `agent-daemon.mjs` —
but only when `TG_API_ID`/`TG_API_HASH`/`TG_SESSION` exist, because a persistent
agent that exits immediately is a restart loop. **Open for you:** run
`scripts/telegram-auth.mjs` once to create the session. The scrape keeps serving
until then.

**5 · The carry engine** (video 2) — `perp-funding-carry` in `strategies.js`, and
`ctx.funding` in the backtest engine. The engine already *charged* funding; a
carry strategy has to *read* it, so `ctx.funding` now exposes `{rate, count,
avg(n)}` over the stamps that have already printed — and a test pins that it can
never see one that has not. The strategy takes the paid side (short when funding
is positive), needs a protective stop by construction, and has a trend filter
because the disaster for a funding short is a violent rally. Without funding data
it stays flat instead of falling back to a price rule wearing the carry name.

This is the library's **third payoff shape** — until now it held mean reversion
and momentum only. Honest health warning, the same one the video gives: carry is
short volatility, it will backtest beautifully, and its tail is by definition
under-sampled. It also cannot ever be an Argus setup: `MIN_PLANNED_R` 1.5 forbids
its payoff shape outright.

396 tests pass, build and 32-route smoke clean.

---

## Queued, not yet done

"Richtig grosse Projekte" — announced, not yet described.

`/watch <url>` costs 50–80k tokens of frames per video; two or three per
conversation is the practical limit. Instagram *carousels* need a detour: yt-dlp
fails with "no video formats", so run `yt-dlp -J --ignore-no-formats-error <url>`
and download the last thumbnail of each entry yourself.

---

## Decided: an own model, and one layer over everything

Two things the user has decided to build. Both were assessed honestly first; the
constraints below are the assessment, not pessimism, and should not be softened.

### What "own AI model" can and cannot mean here

The GPU is an RTX 5080 — 16 GB, ~13 GB free.

| | Feasible? |
|---|---|
| Pretrain an LLM from scratch | **No.** Millions of dollars, thousands of GPUs, months. Nobody should promise this. |
| Fine-tune an open LLM (Llama 8B / Qwen, QLoRA) | Technically yes. But fine-tuning teaches STYLE and FORMAT reliably and KNOWLEDGE poorly, and there are 98 closed trades — nowhere near enough to teach a model anything about markets. |
| **Train a market model** | **Yes, comfortably.** Kronos-base is `d_model 832, 12 layers` ≈ 100M params; that trains on this card in hours. |

**The asymmetry that decides it: there is almost no text data and effectively
unlimited market data.** Binance klines are free and go back years. So an own
*market* model is honest; an own *language* model trained on our data is not.

### Where it would help the agents — and where it would not

- **Replacing Cortex's LLM with a small fine-tuned model would make it worse.**
  Generating working strategy code from a paper is the hardest task an LLM can
  be given; an 8B model would be far behind the llama-3.3-70b it uses now. And
  Cortex's actual problem is measured above: it only sees abstracts.
- **Argus's event channel** (news → directional bias) is narrow classification
  where a small model could compete — but Argus's problem is entries with no
  edge, not the LLM. An own model there changes nothing about −0.25R.
- **Where an own model does belong: as a SIGNAL SOURCE, not as the brain.**
  Exactly the role Kronos plays now — a forecast that goes through the same
  gauntlet. Then it competes against Kronos and against a random walk, on
  machinery that already exists.

### The recommended order

1. **The layer first.** ✅ **Wave 1 built, 13 Aug — see `docs/BOARD.md`.**
   `/board` on the site, `/api/board` as the endpoint, `src/lib/board/` as the pure,
   tested half. Twelve resources over Argus, Kronos, the arena, the monitor, the
   charts, the news and the bias; 270 KB of raw endpoints answered in 6.4 KB of
   digest. Read-only by design. Wave 2 (Cortex, registry, vol, Telegram,
   portfolio) is a listed to-do in that file, not new machinery.
2. **Then fine-tune Kronos on our markets.** Shortest honest path to "our own
   model": the script already ships (`GitHub/Kronos/finetune/train_predictor.py`),
   data is unlimited, the card is enough, and the comparison is already built —
   ours vs Kronos-base vs random walk on the same scoreboard. Our weights, our
   data. That is legitimately an own model.
3. **Then, if wanted, tokenizer + predictor from scratch** (`train_tokenizer.py`
   is there too) with our own architecture choices. Then it is entirely ours.

### For the CV — the honest framing

"I fine-tuned an LLM" is what everyone writes; as a signal it is near zero.
**"I trained a time-series model on my own data and evaluated it against a random
walk with purged cross-validation — and it lost"** is far stronger, because
honestly reported negative results are rare.

And the strongest item is already built and merely unlabelled: **the evaluation
discipline.** A meta-label gate that refuses to ship a model the sample cannot
justify. A walk-forward that breaks the circularity. An arena that concluded the
micro-price does not pay for itself. That is what separates someone who
understands quant from someone who followed a tutorial.

---

## Rules learned the hard way

- **On Windows, every `spawn`/`spawnSync`/`execFile` of a non-node binary needs
  `windowsHide: true`.** Node defaults to false, and that was the cause of the
  console windows that kept flashing — not the terminal setting.
- **Check the live page, not just the code.** The arena's model had been failing
  to build for hours while every test passed.
- **When a result is too good, check the arithmetic before believing it.** A
  0.3-tick adjustment cannot move an error by 480 ticks.
- **When you put a gate in front of another gate, verify the counters read
  correctly when both fire.** Two instrumentation bugs came from exactly this.
- Argus stores timestamps in **milliseconds**, Kronos (Python) in **seconds**. A
  chart marker placed 1000× too late does not render and reports no error.
