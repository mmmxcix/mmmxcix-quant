# WIP: batch quotes (Phase 1, items 3 + 4) — NOT VERIFIED, DO NOT MERGE

Branch `wip/batch-quotes`, stacked on `fix/stale-quotes-pnl` (PR #2), because
both change `src/lib/quotes.js`. No PR is open on purpose. This branch exists
so the work survives the build session. The rule was "verify before
committing", and the build session's network policy blocks `fc.yahoo.com` and
`query1.finance.yahoo.com`, so the live check has not run.

## What the branch changes
- **`src/lib/quotes.js`:** stock quotes for the whole list come from **one** `/api/yahoo/v7/finance/quote?symbols=A,B,…` request per tick, instead of one v8 chart request per symbol (Monitor: 28 → 1).
  - A symbol the batch doesn't return, or a failed batch, falls back to the old per-symbol v8 path, so an outage costs no more than today.
  - New exports: `fetchStockQuotesBatch`, `parseQuoteBatch`, `fetchSparks`, `parseSparkBatch`.
- **Sparklines:** `v8/finance/spark?symbols=…` is used **only** for sparklines (the Dashboard watchlist card), once per symbol per session. It is never used for prices.
- **`functions/api/yahoo/[[path]].js`:** allows `v7/finance/quote` with the crumb (30 s TTL). On a 401 from Yahoo (cached crumb invalidated) it re-handshakes once instead of failing for up to 25 min.
- **`vite.config.js`:** the dev proxy attaches the crumb to `v7/finance/quote`.
- **Monitor** polls every 60 s (was 30 s). The local IBKR path stays at 3 s, since it never touches Cloudflare.
- **`src/lib/visiblePoll.js`** (`visibleInterval`): no ticks while `document.hidden`, one catch-up tick on return. Applied to every poll that didn't already pause: Monitor, Watchlist, Portfolio, Dashboard watchlist card, Arena, Board, FleetSwitch, and seven WorldMap layers.
- **Tests:** `test/batch-quotes.test.mjs`, 7 tests against **mocked** Yahoo responses.

## What is unverified
Everything that depends on how **live Yahoo** behaves. The mocks encode assumptions, and the live check has to confirm each one:
1. `v7/finance/quote?symbols=` (with crumb) returns **all 28** Monitor stock symbols in one response, including indices (`^GSPC`, `^GDAXI`, …), FX (`EURUSD=X`), futures (`GC=F`, `CL=F`), yields (`^TNX`, `^FVX`), `^VIX`.
2. Every row has `regularMarketPrice` and `regularMarketChangePercent`.
3. `regularMarketChangePercent` is in **percent** (1.5 = +1.5 %), not a fraction, and agrees with the old v8-derived change (within 0.5 pp).
4. `v8/finance/spark?symbols=` returns a close series per symbol, and which of the two response shapes `parseSparkBatch` accepts it uses.
5. In production: the Pages proxy's crumb handshake works for `v7/finance/quote` the same way it does for `v7/finance/options`. This one needs the `--site` run below.

Not covered by the script, so check by hand on the preview deployment: Monitor, Dashboard and Portfolio render prices, the Network tab shows **one** `/api/yahoo/v7/finance/quote` request per tick, and nothing polls while the tab is in the background.

## How to verify
From any machine that can reach Yahoo (your PC, or this session once the two hosts are allowed):

```
git checkout wip/batch-quotes
npm install
node scripts/verify-yahoo-batch.mjs
```

- It does its own crumb handshake and prints a per-symbol table: v7 price, v7 change %, v8 change %, deviation, fields present.
- Exit code 0 and `RESULT: OK` means checks 1–4 pass. Any `FAIL` line names the symbol and what was wrong.

Then, after a preview deployment of this branch exists, check the deployed proxy (point 5):

```
node scripts/verify-yahoo-batch.mjs --site https://<preview>.mmmxcix-quant.pages.dev
```

## After it passes
Rebase onto `main` once #2 is merged (or keep it stacked), squash the WIP commit into a normal commit, delete this file, and open the PR. If a check fails, fix the parser or fallback first. The per-symbol fallback means a partial v7 failure degrades cost, not correctness, but a **unit** mismatch in check 3 would show wrong numbers and must block the PR.
