# Argus — the 24/7 alt-data day-trading agent (architecture)

> Working codename **Argus** (the hundred-eyed watcher — it sees ships, planes,
> conflicts, news *and* the tape). Rename freely.

Argus is a **sibling to Cortex**, not a replacement. Cortex researches *durable*
strategies from the literature. Argus hunts *current, event-driven* opportunities
in real time, using **both price action and our worldmonitor alt-data + news**,
paper-trades them autonomously, and — on a real account — only **notifies** (never
places orders). It learns from its own outcomes like Hermes.

## Hard constraints (non-negotiable)
- **IBKR is READ-ONLY forever.** Argus never places a live order. Live mode =
  notifications only. There is no order endpoint on the live path, by design.
- **Notify-only live** trade cards carry entry, **stop-loss, take-profit**, size
  suggestion, horizon, invalidation, and the **reasoning + evidence**. The human
  executes.
- **DSR / multiple-testing discipline** gates every "is this pattern real / should
  I auto-code it" decision — same as Cortex, so alt-data noise can't fool it.
- **Correlation ≠ causation guard:** every event thesis must declare an
  invalidation condition and is scored on *out-of-sample outcomes*. The ledger
  exposes when a channel is just adding noise; Argus de-weights it.
- Educational framing throughout. Not investment advice.

## The loop (every ~5–15 min, 24/7; crypto always, equities in RTH)
1. **Perceive** — snapshot the world:
   - *Market:* intraday candles for a watchlist via `marketdata.mjs`.
   - *Alt-data:* `/api/world` (ships·planes·jamming), `/api/conflicts`,
     `/api/disasters`, `/api/fires`, chokepoint congestion + instability scores.
   - *News:* `/api/news` + the monitor's country news pins.
   - *Book:* open Argus theses + (read-only) account positions.
2. **Detect** — two opportunity channels:
   - **(a) Technical** — deterministic intraday scanners (breakout, VWAP reclaim,
     momentum, mean-reversion, gap-fill). Reuse the `mining.mjs` scan style + the
     existing VWAP / Avellaneda / EventLab builders.
   - **(b) Event / alt-data** — an LLM (via **OmniRoute**) reads a compact,
     *delta-focused* briefing (see `altdata-brief`) and proposes theses. Strict
     structured output: `{instrument, side, thesis, horizon, invalidation,
     confidence, evidence[]}`.
3. **Validate** — before any action:
   - *Technical:* backtest-lite the rule on recent history (positive expectancy
     with fees on this instrument?). Reuse `backtest.js`.
   - *Event:* map thesis → tradable instrument; check it isn't already priced in
     (recent reaction); event-study backtest where data allows ("when {signal}
     happened before, what did {instrument} do over {horizon}?"). When no formal
     backtest is possible, take a **risk-defined** trade and log the thesis for
     later scoring.
   - *RiskGate:* sizing, max concurrent theses, correlation + daily-risk limits,
     no-trade windows (illiquid hours).
4. **Act:**
   - *Paper (default):* fill via `ibkrPaper` (paper account) or a simulated
     ledger; record entry/SL/TP/thesis/evidence.
   - *Live (opt-in):* **notification only** — email (Resend, already wired) and/or
     Telegram/push, with the full trade card. No order is placed.
5. **Manage** — each loop, update open theses: SL/TP hit? invalidation triggered?
   time-stop? Close and record the outcome (R multiple, right-for-the-right-reason).
6. **Learn (Hermes-style)** — a mistake/outcome ledger:
   - Aggregate by channel / signal-type / instrument / regime → which make money.
   - De-weight losing patterns (regime-rotation), quarantine decaying channels
     (incubation-quarantine). Feed a "what I've learned" brief into the next run.
   - **Auto-code:** when a *repeatable* pattern clears enough independent
     occurrences with DSR control → generate a vectorized strategy and push it
     into the existing **Lab → Registry** promotion pipeline (Cortex's gauntlet
     re-validates it into a durable strategy).

## Components (★ reuse · ☆ new)
- ★ `scripts/marketdata.mjs`, `src/lib/backtest.js`, `src/lib/riskGate.js`,
  `scripts/ibkrPaper.mjs`, `/api/lab` (KV state), `aiCall()`/OmniRoute,
  `/api/world|news|conflicts|disasters|fires`, existing signal builders
  (`avellaneda`, `eventLab`, VWAP).
- ☆ `scripts/argus-agent.mjs` — the loop.
- ☆ `scripts/altdata-brief.mjs` — turns raw world/news snapshots into a compact,
  **delta-focused** structured briefing for the LLM (summarize the *changes* +
  notable states; never dump raw data).
- ☆ `src/lib/theses.js` — thesis model + lifecycle (open → manage → close),
  R-multiple accounting.
- ☆ `functions/api/argus.js` — KV state (`argus:theses`, `argus:ledger`,
  `argus:learned`), token-gated writes, public read for the UI.
- ☆ `src/pages/Argus.jsx` (or a Cortex tab) — live theses, trade cards with
  reasoning, the outcome ledger, the "what it learned" panel, the live
  notification log. Honest labels.
- ☆ notification layer — Resend trade-card emails (reuse the digest setup);
  optional Telegram.

## Phased build
- **Phase 0 — skeleton, no LLM.** Thesis model + KV state + a loop that runs only
  the **technical** channel: scanners → backtest-lite → paper fills → ledger.
  End-to-end verifiable, zero LLM risk. Ships the Argus UI page (theses + ledger).
- **Phase 1 — alt-data brain.** `altdata-brief.mjs` + the LLM event channel
  (paper only) + trade cards with evidence in the UI.
- **Phase 2 — learning + auto-code.** Outcome scoring, channel de-weighting, the
  Hermes brief, and promotion of repeatable patterns into the Lab/Registry.
- **Phase 3 — notify-only live.** Resend/Telegram trade cards — only after the
  paper track record is credible.

## Refinements (Jul 25 discussion) — confirmed direction
- **Name:** Argus. ✔
- **Universe = what retail day-traders actually trade:** forex majors (24/5,
  session-aware), the well-known indices/ETFs (SPY, QQQ, DAX…), popular stocks
  (AAPL, NVDA, TSLA…), crypto majors (24/7). Scanners are cheap math, so a broad
  40–60 instrument list is fine; the LLM stays selective.
- **Dynamic news-driven tickers:** on *extreme* news about a specific
  company/asset (blowout earnings, hot product, factory fire, etc.), Argus
  resolves the **affected instrument** and evaluates it directly — even if it
  wasn't on the base watchlist. This is the differentiator (news → ticker →
  trade), and it wires the alt-data/news channel straight into instrument
  selection.
- **Multi-timeframe:** scan several candle types together (5m + 15m + a higher
  TF like 1h/daily for bias), not one. Confluence: higher TF = trend/bias,
  15m = structure, 5m = entry timing.
- **Adaptive watch-mode:** base loop 15 min, BUT when a sub-15m setup is
  *forming but not yet a clean entry*, Argus parks it in a `forming` watch-state
  and polls it faster (~1–3 min) until it either **triggers** (enter) or
  **invalidates / times out** (drop). A small state machine per candidate setup.

## Decided (Jul 25)
1. **News-play stance** ✔ — default **continuation on confirmation** (we enter
   the retail/PEAD wave with deliberate delay, never the HFT spike); overreaction
   **fade** only on an extreme gap. Argus picks per-setup. News timing reality:
   scheduled (earnings) reprices in seconds then the crowd + PEAD drift runs
   ~15 min → days; unscheduled shocks amplify over minutes → hours. Our latency
   is fine because we ride the wave, not the spike.
2. **Timeframes** ✔ — {1h bias · 15m structure · 5m entry · 1m in watch-mode}.
3. **Risk = portfolio-heat model** ✔ (all config constants, tunable):
   - **Total heat cap** = **6%** of paper equity across ALL open positions.
   - **Base per-trade risk** = **2%**, but `risk = min(2%, remaining_heat)`, so
     late trades auto-shrink and new setups wait (watch-mode) when heat is full.
     → per-trade risk scales with how many trades are open (user's ask).
   - **Stop** is structural / ATR-based (Argus estimates it); the % only sets
     **position size** = risk-budget ÷ stop-distance. No fixed-% stops.
   - **Daily-loss breaker** = **−4%** realized → pause new entries till next
     session. No cap on trade *count*, but the heat cap bounds total risk.
4. **Fill realism** ✔ — per-asset-class costs (forex spread, crypto fee, equity
   slippage) in paper fills.
5. **Live notification channel** (Phase 3, later) — Resend email default ±
   Telegram. Deferred.

**Architecture is decision-ready → build Phase 0.**

## Overhaul (Aug 20 2026) — measured, not argued

Every change below shipped with its counterfactual computed on the live ledger
(203 trades, Aug 11–19); the pre-ship gate killed two proposals the numbers did
not survive (time-stop: −2.7R residual net of firstbreak; break-even stop:
negative at every trigger — it now runs as a standing MONITOR, `state.beStudy`).

- **First-break invalidation** (`LAB_ARGUS_INVAL_MODE=firstbreak`, default): the
  2-bar confirm delay cost −0.575R per invalidated trade (hurt 32/33, helped 0).
  Exit fires on the first close beyond the level (buffer 0.15) at ≥0.60R adverse.
  The 12/24h reviews keep auditing it; `shadowConfirmExitR` pairs every exit with
  where the old rule would have landed.
- **Bar-replay exits**: every 5m bar since the last seen one is examined (a stop
  wicked between polls used to be missed entirely); open positions are settled
  BEFORE the scan/LLM work each cycle; `barsSeen` counts bars, not polls.
- **Flat sizing** (`LAB_ARGUS_RISK=0.0035` default): the learned multiplier had
  negative realized covariance with outcome (0.46% risked after losses vs 0.38%
  after wins). Learning now decides skip/rank only, never size.
- **Entry bans**: Asia-session crypto shorts (`LAB_ARGUS_BLOCK_ASIA_SHORTS`,
  −0.575R × 27, BH-significant, replicated pre-fix) and LINKUSDT
  (`LAB_ARGUS_SYMBOL_BLOCKLIST`, −0.566R × 24; time-boxed, re-admit ~Sep 2 via
  probes). ADAUSDT deliberately stays as the multiplicity control.
- **Scanner retirement** (`LAB_ARGUS_KINDS=breakout,mean-reversion,liquidity-sweep`):
  six kinds with ~zero fills in 8 days stop paying scan cost and multiplicity.
  The unused 15m fetch is gone.
- **Leverage ≤25, liquidation ≥2 stop-distances** (was: liq a hair past the stop;
  11 overshoot stops at mean lev 34 gave back −2.6R).
- **Ledger integrity**: `explore`/`regime`/`conviction`/`atrPct`/`rvol`/`limitFill`
  now survive onto closed records (the openThesis whitelist silently dropped them —
  1,187 probe grants, zero labeled probes); the pace ledger is actually populated
  (the "12/day" cap admitted ~19 because closes refunded slots); day-start equity
  survives restarts (the −4% breaker used to re-arm from drawn-down equity).
- **Learning repair**: lessons derive at the evidence floor (n≥8) so the
  thin-bucket skip exists in production, not only in tests; rule-(a) refusals are
  probeable; walk-forward now replays the deployed policy.
- **Deleted**: correlation-aware heat band (two constants in disguise, the larger
  one mis-signed inside an all-USDT book) — one flat 10% cap.
- **Shadow gates** (log-only, on the thesis): `regimeWouldVeto` (mean-reversion in
  a trending HMM state), `htfWouldVeto` (continuation against 1h bias). Enforce
  only after ≥30 vetoed-but-taken closes measure negative.


---

# The mandate redo — Aug 26 2026

Everything above describes what Argus was designed to be. This section records
what it actually *did*, why that produced a losing book of tiny trades, and what
changed. Written from the live ledger, not from intent.

## What the book actually said

47 closed trades, the entire record since the Aug-20 overhaul, over 2.3 days:

| | |
|---|---|
| Result | −7.15R, −$203, 27.7% wins, Ø −0.15R (t = −0.75) |
| Risk per trade | 0.27% of equity — 47 trades moved the account by 2% |
| Timeframe | 5m on **every single trade** |
| Source | `technical` on **every single trade**; `event`: none, ever |
| Kinds | 38 mean-reversion, 5 liquidity-sweep, 4 breakout |

t = −0.75 is the first thing to say plainly: **this book does not prove Argus
loses.** It proves the book is small, narrow, and taken in the wrong places. The
one bucket that *is* separable is breakout (0/4, Ø −0.92R, t = −3.06), and n=4
proves nothing either.

## The three findings

**1. It was structurally locked out of every liquid session.**
Every one of the 47 trades opened between 21:00 and 06:00 UTC. Not one in London,
not one in New York, on any day.

| UTC hour | 0 | 1 | 2 | 3 | 4 | 5 | 6 | … | 21 | 22 | 23 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| trades | 21 | 7 | 1 | 2 | 1 | 3 | 1 | **0 (07–20)** | 7 | 2 | 2 |
| ΣR | −10.8 | +4.2 | −1.0 | +0.6 | +1.7 | −3.0 | −0.8 | — | −2.1 | +2.9 | +1.2 |

The cause was not a preference for the overnight tape. The pace cap — added for
the right reason, to stop 60 trades a day — resets at 00:00 UTC, which is the
*start of the deadest window*, and a 24/7 agent spent all twelve slots there
before dawn. 12 of 12 used by 06:00 on all four days; `blocked: true` from then
until midnight. Hour 00 UTC alone (02:00 Swiss, the thinnest hour in both crypto
and futures) carried 21 trades and −10.8R — the entire loss.

By session: Asia −9.09R over 36 trades, everything else +1.93R over 11.

**2. It signalled on 5m bars from a 15-minute loop.**
New setups are only discovered on the full scan; the 2-minute loop only revisits
instruments that already have something open or forming. So a 5m signal reached
the entry a median of **305 seconds** — a whole bar — after its bar closed
(p90 379s, max 525s). The book splits on it: entries within 2 minutes averaged
−0.04R (n=16), everything slower −0.21R (n=31). On a mean-reversion-from-VWAP
setup that is buying after the snap-back and stopping out on the retest.

**3. The differentiator has never been built.**
`docs/DAYTRADER_AGENT.md` calls news → ticker → trade the thing that makes Argus
worth having. In the code the event channel only ever set a *bias* that nudged a
technical setup's conviction and could veto one on strong disagreement. It could
not open anything. With no technical setup on a symbol there was nothing to tilt,
so the idea died silently — hence zero `event` rows in the ledger.

And underneath that: the channel's LLM was not flaky, it was **dead**. Probed
directly against the local OmniRoute on Aug 26 — `groq/*` returns 404 on every
model id (the configured model was decommissioned), cerebras / mistral /
openrouter all answer "No active credentials for provider", github-models is 410,
ddgw fails its anti-abuse challenge. The only live routes are the Claude
subscription, which background agents must never resolve to.

## What changed

**Session-aware pace** (`src/lib/argus/pace.js`). The daily budget is split
per session — `ny 5 · london 4 · asia 2 · off 1` — summing to the same twelve.
The split is a-priori by liquidity, deliberately *not* fitted to a 47-trade P&L;
that book merely corroborates it. Unused slots do **not** roll over. Once a
session cap is in force it *replaces* the daily total rather than sitting under
it — otherwise twelve overnight trades would still have spent London's slots
through the global counter, which is the exact defect being repaired. The
backstop against a mistyped budget moved into `parseSessionBudget`, which clamps
each session. Override: `LAB_ARGUS_SESSION_BUDGET="ny:5,london:4,asia:2,off:1"`.

**15m signals** (`core.aggregateCandles`, `scanners.scan`). Entries are signalled
on 15m bars aggregated from the 5m feed already being fetched — wall-clock
bucketed, still-forming bar withheld, zero extra requests. A 15-minute loop is
then at most one bar behind, which is the lag a 15m trader actually lives with.
Exits keep replaying 5m bars: precision where it is free. A hard staleness gate
(`MAX_SIGNAL_LAG_BARS`, 1.5 bars) refuses an entry whose signal bar closed too
long ago, so the mismatch cannot be reintroduced by flipping one env var.
`LAB_ARGUS_SIGNAL_TF=5m` restores the old behaviour.

**Size follows evidence** (`core.riskLadder`). "Only does minor trades" was a
fair complaint and the answer is not simply a bigger flat bet — the previous
*fitted* sizing model had negative realized covariance to outcome (see
`BASE_RISK`). The ladder multiplies base risk (×1.5 / ×2 / ×3, capped at 1%)
only while the **whole book** shows positive expectancy with enough sample *and*
t-statistic: n≥40 & t≥1.0, n≥80 & t≥1.5, n≥150 & t≥2.0. Sample gates before t,
recomputed from the current book on every trade, straight back to ×1 the moment
expectancy turns negative. Three coarse rungs, no per-bucket view, no memory —
a continuous function of t would be a fitted sizing model wearing a hat.

**The catalyst channel trades** (`src/lib/argus/eventTrade.js`). A high-confidence
(≥0.75), fresh (≤90 min) catalyst on a symbol the scanners had nothing to say
about now opens a risk-defined thesis of its own: structural ATR stop (1.5×),
target at 2.5R, tagged `catalyst` so `learn.sourceOf` files it under `event` and
the channel is graded on its own record. It runs *after* the technical pass and
only when nothing was opened, so it never competes with a chart setup — it takes
the trades that would otherwise not exist. It draws on a separate small budget
(2/day) rather than the session slots, because a channel that always loses the
ranking never gets graded, and "it lost the queue" is not evidence. Every other
gate is unchanged: volatility, skill vetoes, learning refusals, sizing.
`catalyst` had to be added to `openThesis`'s field whitelist — the same trap that
previously killed `explore` and `regime`.

**The channel reports its own health.** `state.eventHealth` counts cycles,
usable replies, biases and catalyst trades per UTC day, and the page shows
"no model" in red when the LLM answers nothing. Its old failure mode was silence:
a dead channel and a quiet news day looked identical.

## Open, and not ours to close

The catalyst channel is **inert until a free provider is connected in OmniRoute**
and `LAB_ARGUS_MODEL` / `LAB_ARGUS_FALLBACKS` point at it. The code path is built,
tested and instrumented; it has nothing to call. Never an `auto/best-*` route —
those resolve to the Claude subscription.

## How to judge this

The old 47 trades were taken under a different mandate (5m signals, overnight
only, flat size) and mixing them into the new record grades the new agent on a
book that no longer exists. The conservative direction — a losing prior keeps the
risk ladder at ×1 longer — so nothing is unsafe either way, but a clean read
means resetting the book (the dev "Reset to $10k" command; the archive keeps the
old trades in `argus_trades`).

The bar is not "is it green". It is: does it now trade London and New York, does
`detectLagMs` collapse, and does the `event` bucket finally have a row in it.
