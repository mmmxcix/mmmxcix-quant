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

## Queued, not yet done

Five videos, with the question asked about each:

| Link | Question |
|---|---|
| `instagram.com/reel/Dbwck6nt3ax` | What is Nebula, is it relevant to us, could it help? |
| `instagram.com/reel/Db8cna4MpOu` | A real quant — what does he say? |
| `instagram.com/p/Db2C1rclLV9` (img 6) | How is *that* agent built? Anything to copy for Argus, given its problems? |
| `instagram.com/reel/DYqhTtMxfqZ` | As a monitor + news upgrade — maybe more than what we have? |
| `instagram.com/reel/Db5b-JJzNgJ` | Also a real quant — what does he say? |

Then: "richtig grosse Projekte" — not yet described.

Use `/watch <url>` for each. They are expensive (50–80k tokens of frames each),
so two or three per conversation is the practical limit.

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
