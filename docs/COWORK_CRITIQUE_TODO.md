# Cowork Critique — Prioritized To-Do

Working list from the Claude-Cowork review (Aug 2026). Severity ×
effort so we can pick the highest-leverage items each session.

**Severity:** S1 = credibility-damaging (looks broken/wrong) · S2 = major UX ·
S3 = minor · S4 = polish.
**Effort:** S ≈ <1h · M ≈ a few h · L ≈ a day+.

**Two standing decisions (do NOT relitigate):**
- **Dither background stays.** The user likes it. It becomes **optional on the
  theme page**, not removed. Any "reduce/remove the background" item means "add a
  toggle + a calmer default intensity," never "delete it."
- **Dev artifacts are not a bug.** "IBKR live quotes (dev)", "DEV ACCOUNT",
  `localhost:5000` only render for the dev/admin account Cowork was signed into.
  They are already gated from the public build → **no public fix needed.**

---

## ✅ Done (this pass)

| # | Item | Sev |
|---|------|-----|
| — | Macro yield curve: exclude real/TIPS/breakeven from the nominal curve (V-shape gone) | S1 |
| — | News: decode numeric + extended HTML entities ("SpaceX's" not "SpaceX&#39;s") | S1 |
| — | Cortex "today" P&L: same-scale baseline, suppress capital-jump artifacts (no more +299% vs flat all-time) | S1 |
| — | Watchlist sparkline colored by its own 30-day trend (down-line never green); calmer "N pending · retry" | S2 |

---

## Priority 2 — Optics & contrast (Cowork's #2)

| # | Item | Sev | Eff | Notes |
|---|------|-----|-----|-------|
| O1 | **Theme page** — user-selectable chart colors + **dither toggle** (off / subtle / full) + intensity | S2 | L | The big one. Persists to localStorage; drives the `--viz-*` + a `--dither-*` var. Inspired by zerotwotrades' signature theme. Ships the dither-optional promise. |
| O2 | **Dither default calmer** on load (before anyone opens the theme page) — lower opacity / coarser grain, esp. on small/hi-dpi screens | S2 | S | Independent of O1; do first so the default already reads cleaner. |
| O3 | **WCAG contrast pass** — bump `--c-dim` / placeholder / faint borders; verify body + label sizes hit AA | S2 | M | Cowork: "too dark, fonts too small." Audit against 4.5:1 (text) / 3:1 (UI). |
| O4 | **World Map** — lighten the ocean/base; make the **Layers panel** collapsible / repositioned so it stops covering the North Atlantic + Europe | S2 | M | Panel is docked over the busiest region. |

## Priority 3 — Tooltips, legends & labels (Cowork's #3)

| # | Item | Sev | Eff | Notes |
|---|------|-----|-----|-------|
| T1 | **Legends/tooltips for every abbreviation** — Argus + Cortex especially (IC, Sharpe, DD, PF, RiskGate terms, regime codes…) | S2 | M | A shared `<Abbr title=…>` / info-dot pattern; write a glossary once, reuse. |
| T2 | **Yield-curve + Macro** labels — tenor axis, what each line is, units | S3 | S | Pairs naturally with the O-block. |
| T3 | **Chart legends** where series are unlabeled (equity books, overlays) | S3 | S | |

## Consistency

| # | Item | Sev | Eff | Notes |
|---|------|-----|-----|-------|
| C1 | **Language mix** — stray German in an English UI ("Kerzen" → "Candles"); sweep for others | S2 | S | Grep the UI strings. |
| C2 | **Symbol duplication** — "BTCUSDT BTCUSDT" (name + symbol both render the ticker) | S2 | S | Fix the label composition; show name **or** a clean `BTC · Bitcoin`. |
| C3 | **Empty states consistent** — one voice/format across cards | S3 | M | |
| C4 | **Skeleton loaders, not the error boundary**, for slow/late data | S2 | M | Cowork saw the error card where a skeleton belonged. Partly addressed (calmer watchlist retry); generalize. |

## Layout

| # | Item | Sev | Eff | Notes |
|---|------|-----|-----|-------|
| L1 | **Academy card heights** unequal → grid rows to equal height | S3 | S | |
| L2 | **Dead vertical space** — tighten pages that scroll empty | S3 | M | |
| L3 | **Analog clocks too tiny** — enlarge or replace with legible digital+TZ | S3 | S | |

## Missing / net-new

| # | Item | Sev | Eff | Notes |
|---|------|-----|-----|-------|
| M1 | **Cross-linking** — click a symbol anywhere → opens its chart | S2 | M | High-value connective tissue; Dashboard/Watchlist/News → Charts. |
| M2 | **Onboarding / "Start here"** — a first-run path so a new user isn't dropped cold | S2 | L | Ties into the Wave-1 landing/welcome work. |
| M3 | **Number coherence** — Dashboard equity (e.g. 79.971) vs portfolio 0.00 must tell one story | S1 | M | Reconcile which book each figure reports; label the source. Investigate next session. |

## Keep (Cowork called these out as good — don't regress)

- Regimes page (HMM) — the visual + concept landed.
- Tools grid — clean, scannable.
- **Honesty** — showing negative/real track records instead of hiding them. This
  is a differentiator; keep it front-and-centre.

---

## Suggested next-session order

1. **O2** (calmer dither default) + **O3** (contrast) — fast, site-wide lift.
2. **C1 + C2** (language + symbol dup) — cheap credibility wins.
3. **T1** (abbreviation glossary/tooltips) — the reusable `<Abbr>` unlocks T2/T3.
4. **M3** (number coherence) — investigate the equity-vs-portfolio discrepancy.
5. **O1** (theme page) — the large one; delivers dither-optional + custom colors.
6. **M1 / M2** — cross-linking, then onboarding (with the Wave-1 landing).
