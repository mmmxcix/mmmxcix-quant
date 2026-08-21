# Cortex vs. the field — why we find nothing, and what the systems that work do differently

*Research date: 2026-08-20. Three parallel web-research passes (LLM-based research agents ·
classical strategy factories · validation doctrine), ~60 primary sources, synthesized against
our own funnel telemetry. Full source URLs at the end of each section.*

## 1. The diagnosis, in our own numbers

From `~/.mmmxcix-research.log` (whole history, 1,010 "promising but none survived" failures):

| First-killing gate | Count | Share |
|---|---|---|
| Absolute Sharpe ≥ 1.0 floor | 790 | **78%** |
| Beat buy&hold Sharpe + 0.10 | 184 | 18% |
| 1-bar-delay robustness | 16 | 1.6% |
| Drawdown / k-fold / DSR / noise / holdout / trade floors | 20 | 2% |

Median best-market Sharpe when the floor killed a candidate: **0.38** (p25 0.23, p75 0.55).
The robustness suite — the part that actually distinguishes real from fake — is almost never
reached. Zero candidates ever cleared everything and died only on the pooled-300-trades floor.

Three independent findings say this outcome is arithmetic, not bad luck:

1. **Realistic single-rule Sharpe is 0.2–0.5.** Carver (Systematic Trading; live blog numbers):
   a *diversified set* of rules on one instrument ≈ SR 0.40; a single rule sits below that; his
   own live per-rule SRs range negative to ~0.9 and he keeps negative-SR rules for correlation.
   "SR consistently greater than 1.0 [is] rarely achieved" — by anyone, including hedge funds.
   Our generator's median 0.38 is exactly on-distribution: **the generator is fine.**
2. **Our floor sits at our own noise ceiling.** Bailey/López de Prado (AMS 2014): expected
   maximum Sharpe of N pure-noise trials on 10y data — at our N ≈ 3,000 windowed trials,
   E[max noise SR] ≈ **1.1**. A Sharpe-1.0 wall therefore admits *only* strategies that are
   lucky/overfit at least as hard as the best of 3,000 coin-flips — which the downstream gates
   then correctly execute. 0/3000 is the designed output of this stack.
3. **10y of one asset cannot even confirm the Sharpe that is realistically on offer.**
   MinTRL (Bailey/LdP 2012): confirming SR 0.4 > 0 at 95% needs ~17 years; SR 0.3 needs ~30.
   Carver draws the practical conclusion: per-rule significance testing is unreachable, so
   nobody sane selects single rules by backtest Sharpe. Quantopian proved it empirically on
   888 real algorithms with true out-of-sample: backtest Sharpe predicted OOS Sharpe with
   **R² < 0.025**, and more backtests per author → worse OOS (SSRN 2745220).

**The conclusion the whole field reached: don't demand hedge-fund Sharpe from one rule on one
market. Change the geometry — pool, combine, or go cross-sectional — and move the harsh
judgment to (a) an empirical null and (b) live paper incubation.**

Sources: qoppac.blogspot.com (Carver rule performance) · the7circles.uk/systematic-trading-1-theory ·
ams.org/notices/201405/rnoti-p458.pdf (MinBTL) · ssrn.com/abstract=1821643 (MinTRL) ·
ssrn.com/abstract=2745220 (Quantopian 888-algo study) · ssrn.com/abstract=65140 (Sullivan/Timmermann/White) ·
sciencedirect.com/science/article/abs/pii/S0304405X1200116X (Bajgrowicz/Scaillet).

## 2. How each working system gets "enough trades"

| System | Unit validated | Sample engine | Per-unit bar | Portfolio bar |
|---|---|---|---|---|
| WorldQuant BRAIN | daily long-short weight vector over 3,000 stocks | ~3.75M position-days per 5y window; evaluated on ~1,250 daily portfolio returns — "trades" don't exist | IS Sharpe ≥ 1.25, fitness ≥ 1.0, turnover 1–70%, sub-universe check, self-corr < 0.7 | firm combines millions of small alphas |
| Carver / pysystemtrade | continuous forecast (±20) per rule, pooled across instruments | daily forecast returns × 30–100 instruments, pooled bootstrap | after-cost SR > **0.2** | portfolio SR ~0.8–1.0 via diversification multiplier (≤2.5) |
| StrategyQuant X | strategy → databank → portfolio | **intraday bars (M15–H1)** + multi-market retests; showcase user: 50k trades pooled, 100–200 strategies/market | SQN ≥ 2.5, stability > 0.9, ~100–200 trades, WF matrix — **no Sharpe-1 floor** | 30+ concurrent strategies, refreshed quarterly |
| Build Alpha | strategy vs **empirical null** | intraday/multi-market; significance from permutation p-values, not N | MCPT p < 0.05 (permute log returns, rebuild OHLC, re-run ×1,000); Vs-Random: beat best-of-random distribution | user portfolio |
| Quantopian | structural profile + 6-month frozen-code OOS | forced breadth (≤5%/position, turnover 5–65% ⇒ hundreds of names) | beta < 0.3, neutrality, style exposures ±0.40 — **no alpha-level Sharpe gate** | allocations after incubation only |
| RD-Agent(Q) (Microsoft) | factor/model added to a SOTA library | cross-sectional IC on CSI300 (300 names × ~870 days) | "beats the current SOTA combination" — relative, not absolute | daily top-k long-short from combined library |
| QuantEvolve | full strategy code in a quality-diversity archive | 6 mega-caps daily; fitness = SR+IR+MDD composite **relative to the incumbent of its niche cell** | none absolute during search | best evolved: SR 0.99 → 1.52 over 150 generations |
| AlphaAgent / QuantaAlpha / alphagen | formulaic alpha in a weighted pool | daily cross-sectional IC; single-factor IC 0.02–0.05 accepted | originality (AST-similarity), complexity caps, top-x% of own pool | pool-level IC / LightGBM combiner |

Recurring patterns, all three research streams agree:

- **Search-time acceptance is RELATIVE** (beat your niche incumbent / the SOTA library / the
  top-5% of your own pool). **Hard absolute bars exist only at deployment.**
- **No dead-end graveyard.** Every evaluated program stays in an archive as a reproducible
  parent (FunSearch/AlphaEvolve/QuantEvolve); prompts contain the parent **plus best cousins
  with their scores**; mutation is a targeted diff on marked blocks, not full regeneration;
  islands/MAP-Elites cells protect diversity so one family can't crowd out exploration.
- **Structured memory beats failure strings**: RD-Agent keeps (task, code, feedback) triples;
  QuantEvolve distills an "insight repository" every 50 generations; AlphaMemo mines AST-diff
  **edit motifs** with success/fail stats and a **veto list** of known-bad patterns.
- **Evaluation cascades**: cheap 1-market screen (or backtest-free scores: IC, stability,
  perturbation, LLM-judged plausibility — AlphaEval) before the expensive full gauntlet.
- **Paper incubation is the real gate**: Quantopian 6 months, Kevin Davey 6–12 months, prop
  firms pass 7–12%. Standard live expectation: **~50–65% of backtest Sharpe retained**
  (McLean–Pontiff decay ~26–58%; Mulligan slope 0.57; Carver's haircut).

Sources: arxiv.org/abs/2505.15155 (RD-Agent) · arxiv.org/abs/2510.18569 (QuantEvolve) ·
arxiv.org/abs/2506.13131 (AlphaEvolve) · nature.com/articles/s41586-023-06924-6 (FunSearch) ·
arxiv.org/abs/2502.16789 (AlphaAgent) · arxiv.org/abs/2602.07085 (QuantaAlpha) ·
arxiv.org/pdf/2606.20625 (AlphaMemo) · arxiv.org/abs/2508.13174 (AlphaEval) ·
arxiv.org/abs/2402.03755 (QuantAgent) · arxiv.org/abs/2407.06567 (FinCon, the one committee
paper with a clean ablation) · github.com/paperswithbacktest/pwb-alphaevolve (AlphaEvolve for
Backtrader) · arxiv.org/pdf/1601.00991 (101 Formulaic Alphas) · strategyquant.com/doc (WF matrix,
cross-checks, genetic options) · buildalpha.com (MCPT, vs-random, noise) ·
qoppac.blogspot.com / github.com/robcarver17/pysystemtrade (forecast pooling).

## 3. What we already do BETTER than the field

Keep these — they are best-in-class and none of the research argues against them:

- **1-bar-delay test with ≥50% Sharpe retention** — exactly the industry's WFE-≥50% number.
- **Formal DSR trial accounting** — literally nobody else in the retail/OSS space does this
  honestly (BuildAlpha approximates it empirically with Vs-Random).
- **Noise perturbation, 30% holdout with signal-IC replication check, per-market cost model,
  hard stop-loss requirement, deterministic + LLM code audit** (look-ahead, side-inverted
  brackets, degenerate signals) — freqtrade built a whole subcommand for look-ahead alone;
  Vibe-Trading's main selling point is these guard rails.
- **Live incubation watchdog with divergence quarantine** — the field's "real gate", already
  built; it's currently starving because nothing reaches it.

## 4. Upgrade plan (proposed, in priority order)

### Tier 1 — change the acceptance geometry — ✅ SHIPPED Aug 21 2026 (01247bd, 5bacf0e)

Implemented as described below, plus one trap found during the build: the
library retest police (`retest-library.mjs` → `progressEntry`, per-market
Sharpe 0.8 / 100 trades) would have buried every pooled rule the day it was
promoted, so an ensemble LEG is now judged on its RULE's pooled record
(`entry.pooled`, carried on every promotion) and a losing leg of a healthy
rule survives — that is what diversification looks like from inside.

Measured on the live 14-market universe, same rule family, **0/14 markets
clearing the old Sharpe-1.0 wall in every case**:

| variant | pooled Sharpe | pooled DD | DSR (60 trials) | recent tail | verdict |
|---|---|---|---|---|---|
| naive EMA trend | 0.567 | 38.0% | 42.6% | −7.0% | fails (DD + decayed tail) |
| + vol/regime filter | 0.626 | 22.7% | 52.6% | +19.3% | **PASS private** |
| + patience/confirmation | 0.758 | 19.5% | 73.7% | +25.7% | **PASS private** |

Neither cleared *prop* (needs pooled DD ≤ 12%) — correct, a prop account dies
at 8% live. Env levers: `LAB_MIN_POOLED_SHARPE` (0.30), `LAB_ENSEMBLE_MARKETS`
(2 legs/rule), `LAB_ENSEMBLE_CORR_CAP` (0.7), `LAB_REVALIDATE_MIN_SHARPE` (0.25).

**Known strictness, deliberately kept:** the pool includes legs where a
daily-ish rule churns to death (SOL 15m, AAPL 15m at 15-minute costs), which
inflates pooled drawdown. Non-portability is a real defect and the improve hint
now names the fix ("make the rule PORTABLE — sit flat where the edge is
absent"). If pooled DD becomes the new universal wall, the honest next step is
inverse-volatility (risk-parity) leg weighting — **not** dropping bad legs,
which would re-introduce the cherry-picking the pooling exists to prevent.

The original plan, for the record:

1. **Pooled evaluation + ensemble promotion (Carver route).** Grade every candidate on its
   POOLED daily returns across all 14 markets (one rule applied everywhere = thousands of
   observations, the instrument-diversification multiplier is free). Accept rules at pooled
   after-cost Sharpe ≥ ~0.3 **plus the full existing robustness suite** (delay, noise, k-fold,
   holdout, DSR, stops). Then combine survivors — correlation-capped, à la Carver/alphagen —
   into ONE "Cortex Ensemble" paper book, and apply the hard bars (Sharpe ≥ 1, beat B&H)
   **to the ensemble**, where they are realistic and statistically meaningful.
   *This preserves the intent of the Aug-9 quality policy — quant-grade promotion — but at the
   level where quant-grade is achievable.*
2. **Relative acceptance inside the search loop.** During search, a candidate is "worth
   keeping" if it lands in the top decile of trailing attempts AND passes robustness — the
   absolute walls move to promotion time. (RD-Agent/QuantEvolve pattern.)
3. **Let incubation judge.** Promote more freely into the virtual paper book (it is virtual;
   the cap + RiskGate already bound it) and grade on **≥50% backtest-Sharpe retention** over
   4–8 weeks — the Quantopian/Davey doctrine, using the incubation machinery we already have.

### Tier 2 — make the improve loop evolutionary (QuantEvolve/AlphaEvolve pattern)
4. **Archive, not graveyard**: every evaluated strategy stays a reproducible parent; improve
   prompts get the parent + 2–3 best "cousins" (similar family, higher score) with their
   metrics; keep islands per strategy family (trend / mean-rev / breakout / vol / seasonal)
   so one family can't monopolize the budget; a niche's incumbent is only replaced by a
   better composite (SR + retention + DD), never by an absolute wall.
5. **Diff-based mutation**: mark ENTRY / EXIT / FILTER / SIZING blocks in generated code and
   ask the model for a targeted change to ONE block per iteration (SEARCH/REPLACE), instead of
   full regeneration — AlphaEvolve's ablation shows this and prompt-context each matter.
6. **Edit-motif memory + veto list**: mine the graveyard for recurring failure patterns and
   successful fix patterns; prepend a short veto list ("don't do X again") and a "what worked"
   list to generation/improve prompts. (AlphaMemo/RD-Agent knowledge base, cheap version.)

### Tier 3 — drop-in validation upgrades (keep all current gates)
7. **MCPT permutation null** (BuildAlpha/Masters): permute log returns, rebuild OHLC,
   re-run the strategy ×1,000 → require p < 0.05. Stronger than our perturbation noise test;
   substitutes parametric significance at low trade counts.
8. **Vs-Random**: run the generation pipeline on shuffled data periodically to measure the
   best-of-random distribution — our candidates must beat it. This is the *empirical* twin of
   our DSR accounting and would also calibrate the DSR window honestly.
9. **Walk-forward efficiency ≥ 50%** as a graded score (OOS/IS retention) alongside k-fold's
   pass/fail; WF-matrix stability (plateau across split configs) for finalists only.
10. **AST-originality gate + complexity cap** at generation time: reject near-clones of
    library/graveyard members before they consume a backtest; cap indicator/parameter count.
11. **Evaluation cascade**: cheap 1-market screen first; full 14-market gauntlet only for the
    top slice. More attempts per LLM dollar and per CPU hour.
12. **Committee → judge-first**: run the (existing) LLM critique BEFORE the expensive gauntlet
    on borderline candidates (QuantAgent's inner/outer loop), not only after survival.

### Tier 4 — new channels (bigger builds, later)
13. **Cross-sectional factor channel** (WorldQuant/RD-Agent route): daily ranking factor over
    an S&P-100/500 universe (Yahoo daily data suffices), long top-k / short bottom-k,
    IC/RankIC fitness, correlation-capped factor pool, LightGBM/linear combiner. This is the
    statistically richest channel and what most of the 2025-26 literature actually mines.
14. **Decay haircut in expectations**: store `expect.sharpe × 0.5–0.65` as the incubation
    baseline (McLean–Pontiff / Mulligan / Carver), so live grading expects the haircut instead
    of flagging it.

## 5. Honest caveats

- The B&H+margin gate killed 18% of near-misses — on BTC/QQQ/NVDA the underlying B&H Sharpe
  exceeded 1 this decade, making the effective bar ~1.3–1.6 there. At ensemble level (Tier 1)
  this gate becomes fair; per-rule per-market it mostly tests "was the asset in a supercycle".
- Even the best-run version of this pipeline can fail: Quantopian executed the full doctrine
  (breadth, structural gates, 6-month incubation, 888+ strategies) and still shut down.
  The research says our *filter* is miscalibrated; it does not promise the market owes us alpha.
- WorldQuant thresholds are community-reverse-engineered; SQX/BuildAlpha throughput numbers are
  vendor marketing; treat specific numbers as directional.
