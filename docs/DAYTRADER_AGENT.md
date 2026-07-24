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

## Open choices (pick before Phase 0)
1. **Watchlist scope** — crypto majors + a handful of liquid ETFs/stocks (SPY,
   QQQ, oil/defense/energy names the alt-data can move)? Start narrow.
2. **Cadence** — 5 min (more responsive, more LLM cost) vs 15 min.
3. **Name** — Argus, or your pick.
4. **Notification channel** for live (later) — Resend email (default) and/or
   Telegram.
