# Static-first audit — outbound calls, free-tier hotspots, failure modes

Read-only audit of the code as of `3ee0142` (branch `refactor/static-first`).
Nothing in the app was changed. Line numbers are against that commit.

**Legend.** Runs: **B** browser · **F** Cloudflare Pages Function · **W** standalone
digest Worker (cron) · **PC** local agent on the owner's machine · **Build**.
**Nothing is fetched at build time.** `vite build` makes no network calls.
`vite.config.js:18,27` (Yahoo crumb) and its `/api/bvol` / `/api/binance-options`
middlewares run only in `npm run dev`.

**The one fact that drives this whole document.** On Pages, *every* `/api/*`
request is a Function invocation and counts toward the **100k/day** limit, even
when the Function answers from `caches.default` (`yahoo`, `news`, `telegram`,
`adsb`, `lse`, `board.mjs`). `cache-control` on a Function response only helps
that one browser. `cf.cacheTtl` on the upstream fetch only spares the upstream.
Only files in `public/` and `dist/` are served without an invocation.
A Function that `fetch()`es its own origin (`bias`, `briefing`, `board`, `ask`)
starts **another** invocation for every self-call.

---

## 1. Outbound-call inventory

### 1a. Browser → third party (direct, no Function)

| File:line | Source | Notes |
|---|---|---|
| `src/lib/data.js:25` | Binance fapi `fundingRate` | paginated, up to 60 calls per backtest |
| `src/lib/data.js:144` | Binance `klines` | paginated 1000/call, up to 6 per chart (more for backtests) |
| `src/lib/data.js:285` | Binance `klines?limit=3` | live-tail poll on Charts (2–60 s by interval) |
| `src/lib/data.js:320` | Binance `klines` | scroll-back |
| `src/lib/quotes.js:62` | Binance `ticker/24hr` (all symbols) | Monitor/Watchlist/Portfolio, every 30 s |
| `src/lib/liveStream.js:59` | Binance WS `stream.binance.com:9443` | Charts live ticks |
| `src/lib/screener.js:72,91` | Binance `ticker/24hr` + `klines` ×30 | crypto screener, 5-min memory cache |
| `src/lib/compare.js:27` | Binance monthly `klines` | Compare |
| `src/lib/search.js:209` | Binance `exchangeInfo` | once per session (multi-MB JSON) |
| `src/lib/fx.js:25` | Frankfurter (ECB) | on a non-USD deposit only |
| `src/pages/WorldMap.jsx:633` | USGS quakes geojson | every 5 min while the layer is on |
| `src/lib/pyRunner.js` | cdn.jsdelivr.net (Pyodide) | opt-in Python mode |
| `src/lib/ibkr.js:57`, `src/lib/omniroute.js:41-99`, `src/lib/argus/llm.js:130` | localhost IBKR gateway / OmniRoute | owner's machine only |
| `src/lib/binanceOptions.js:51` | Binance eapi | used only by the PC relay and the vite dev middleware (no CORS in browsers) |

### 1b. Browser → own `/api/*` (each = 1 Function invocation)

| File:line | Route | Trigger |
|---|---|---|
| `src/lib/data.js:175,361` | `/api/yahoo` v8 chart | every stock chart/backtest; sub-hour stock intervals fetch in chunks (`data.js:216`) |
| `src/lib/data.js:296` | `/api/yahoo` v8 chart | stock live-tail poll (Charts, Dashboard) |
| `src/lib/quotes.js:37` | `/api/yahoo` v8 chart, **one call per stock symbol** | Monitor (28 symbols), Watchlist, Portfolio: every 30 s |
| `src/lib/screener.js:116` | `/api/yahoo` ×50 | stock screener scan |
| `src/lib/factors.js:70` | `/api/yahoo` ×41 | BAB / correlation (fetchRetry) |
| `src/lib/factors.js:283` | `/api/yahoo` ws timeseries ×40 | accruals (plain fetch, no retry) |
| `src/lib/factors.js:348` | `/api/yahoo` v10 quoteSummary ×40 | short interest (plain fetch, no retry) |
| `src/lib/options.js:89` (+`:240` up to 6 expiries) | `/api/yahoo` v7 options | Options page |
| `src/lib/fundamentals.js:17` | `/api/yahoo` v10 quoteSummary | Charts info panel + BiasSection |
| `src/lib/search.js:190` | `/api/yahoo` v1 search | per debounced keystroke (150 ms) |
| `src/lib/compare.js:64` | `/api/yahoo` v8 chart | Compare, dividends |
| `src/components/BiasSection.jsx:21,55` | `/api/yahoo` ×6 timeframes + `/api/bias` | every Charts symbol view |
| `src/lib/macro.js:14`, `src/lib/lse.js:18,45` | `/api/lse` | Macro pages, LSE candle source |
| `src/lib/volData.js:12` | `/api/vol` | Volatility page |
| `src/lib/binanceOptions.js:359,376` | `/api/binance-options`, `/api/bvol` | Crypto options panel |
| `src/lib/geoNews.js:61` | `/api/news` + `/api/telegram` | map news layer, every 5 min |
| `src/pages/News.jsx:425 / :325` | `/api/news` (90 s) / `/api/telegram` (120 s) | News page |
| `src/pages/Briefing.jsx:225` | `/api/briefing` | Briefing tab |
| `src/pages/WorldMap.jsx:363,400,590` | `/api/world` **three times** (ships 45 s, planes 30 s, jamming 2 min) | Map |
| `src/pages/WorldMap.jsx:450,469,490,610` | `/api/fires`, `/conflicts`, `/disasters`, `/projects` | Map layers, 10–30 min |
| `src/lib/satellites.js:23` | `/api/satellites` | Map |
| `src/lib/ais.js:82` | `/api/ais-stream` (WebSocket) | admin only |
| `src/lib/planes.js:44,84` | `/api/adsb` | only from `Planes.jsx`, which is **not routed** (dead code, as is `Ships.jsx`) |
| `src/pages/Dashboard.jsx:39,45` | `/api/yahoo` per watchlist symbol | home page, every 30 s |
| `src/pages/Dashboard.jsx:423` | `/api/yahoo` per position/watchlist symbol | home equity curve |
| `src/pages/Dashboard.jsx:103` | `/api/lab` | home page, every 60 s, **also for public visitors (401)** |
| `src/pages/Dashboard.jsx:354` | `/api/argus` | home page, every 60 s |
| `src/pages/Argus.jsx:106` | `/api/argus` | every 30 s |
| `src/pages/Arena.jsx:321-322` | `/api/arena` + `/api/kronos` | every 20 s, no hidden-tab check |
| `src/pages/Board.jsx:53,434` | `/api/board` | every 60 s; fans out server-side |
| `src/pages/Board.jsx:144-161` | `/api/ask` | per chat turn (LLM) |
| `src/lib/portfolio.js:109,161` | `/api/prefs` | once per session (stops on 401) |
| admin-only: `LabStatus.jsx:360`, `Registry.jsx:78,160,732`, `RiskGate.jsx:32`, `BrainVault.jsx:64`, `AlwaysOnSwitch.jsx:15`, `FleetSwitch.jsx:28` (15 s), `NativeRunPanel`/`nativeJobs.js`, `mlMemory.js`, `registry.js`, `Backtest.jsx:274` (`/api/generate`) | various | dev account |
| `src/pages/News.jsx:115`, `src/lib/digestSync.js:135` | `/api/subscribe` | on submit |

### 1c. Pages Function → third party

| File:line | Upstream | Parses in the Worker? |
|---|---|---|
| `functions/api/yahoo/[[path]].js:24,31` | fc.yahoo.com + getcrumb | small, cached 25 min |
| `functions/api/yahoo/[[path]].js:92` | query1.finance.yahoo.com | no, streams the body |
| `functions/api/news.js:240` | **15 RSS feeds** in parallel | **yes**: regex XML parse of every feed, entity decode, sort (`:182`, `:293-338`) |
| `functions/api/telegram.js:81` | t.me/s ×7 | **yes**: regex HTML parse (`:63`) |
| `functions/api/vol.js:48` | DoltHub SQL API (4 pages × 1000 rows) | **yes**: on sync; and **every GET** parses the ~2.3k-symbol blob (`:71`), `leaders` sorts it, `iv` scans all ranks (`:166`) |
| `functions/api/bvol.js:76` | data.binance.vision ZIP per day (up to 7/run) | **yes**: unzip (`DecompressionStream`) + per-second CSV sample (`:80-87`) |
| `functions/api/adsb/[[path]].js:46,48` | adsb.lol → airplanes.live fallback, adsbdb | no (text pass-through) |
| `functions/api/lse/[[path]].js:61` | LSE data API | no |
| `functions/api/ais-stream.js:48` | aisstream.io WS | per client frame JSON.parse (`:78`); long-lived socket |
| `functions/api/bias.js:159,178` | Groq / Gemini | prompt build + parse; plus 3 self-calls (`:51,76,89`) |
| `functions/api/briefing.js:196,215` | Groq / Gemini | plus self-calls `/api/news` (`:93`) and per-symbol `/api/yahoo` ×2 (`:146,171`) |
| `functions/api/ask.js:54,74` | Groq / Gemini / local | plus board reads |
| `functions/api/generate.js:245,269,302` | Anthropic, Mistral, Groq, Gemini | admin only |
| `functions/api/subscribe.js:100` | Resend | on subscribe |
| `functions/_lib/board.mjs:27` | Binance `ticker/24hr` | JSON parse |
| `functions/_lib/board.mjs:45,141` | **own origin** `/api/yahoo`, `/api/news`, `/api/lab`, … | yes, re-parses each |
| D1/KV reads in `argus.js:35`, `arena.js`, `kronos.js:37`, `binance-options.js:30`, `telegram.js:114`, `snapshot.js:150`, `world.js:45`, … | own storage | JSON.parse per GET (argus ~171 KB, measured 0.5–1.5 ms in docs/BOARD.md) |

### 1d. Digest Worker (`workers/digest-worker.js`, cron 06:00 UTC)

| Line | Target |
|---|---|
| `:106` | Binance 24hr ×2 |
| `:117` | **own** `/api/yahoo` ×2 (Function invocations) |
| `:141` | **own** `/api/news` |
| `:158` | **own** `/api/briefing` (LLM + more self-calls) |
| `:482` | Resend, one per subscriber |
| `:575` | **own** `POST /api/vol` → DoltHub sync runs *inside a Pages Function* |
| `:607` | **own** `POST /api/bvol` → ZIP/CSV parse runs *inside a Pages Function* |

### 1e. PC agents (`scripts/`) — outside Cloudflare, listed for completeness

`ais-agent.mjs` (adsb.lol/airplanes.live `:115`, FIRMS `:238`, UCDP `:323`, GDACS `:385`,
World Bank `:422`, CelesTrak `:458`, aisstream) → pushes `/api/world`, `/fires`,
`/conflicts`, `/disasters`, `/projects`, `/satellites`.
`binance-options-relay.mjs` (eapi) → `/api/binance-options`. `insider-agent.mjs`
(SEC EDGAR) → `/api/insider`. `statements-agent.mjs`, `telegram-mtproto.mjs` →
`/api/statements`, `/api/telegram`. `argus-agent.mjs`, `arena-agent.mjs`,
`lab-agent.mjs`, `kronos/forecast.py` (Binance, Yahoo, alternative.me, local LLM)
→ `/api/argus`, `/arena`, `/lab`, `/kronos`. `polymarket-*.mjs` (goldsky, Polygon RPC),
`research-agent.mjs` (arXiv, OpenAlex, Crossref, HN, GitHub). The pattern already
works: PC fetches and parses, site stores. The cost problem is only on the **read** side.

---

## 2. Hotspots for the free-tier limits

### 2a. Per page load / per user (the 100k/day budget)

Rough invocations per open tab. Estimates from the code, not measured. Verify
against the Pages analytics per route before trusting the ranking.

| Rank | Where | Per tab | Why |
|---|---|---|---|
| 1 | **Monitor** (`/?view=monitor`) via `quotes.js:37,151` | 28 per 30 s = **~3,400/h** | one `/api/yahoo` per stock symbol. One tab left open for a day ≈ 80k, close to the whole budget |
| 2 | **Home / Dashboard** (`Dashboard.jsx:39-79,103,354,423`) | ~13 on load, then ~12/min ≈ **720/h** | per-symbol Yahoo tails every 30 s, plus `/api/lab` (401 for every public visitor) and `/api/argus` every 60 s |
| 3 | **Watchlist / Portfolio** (`Watchlist.jsx:82`, `Portfolio.jsx:182`) | N stocks per 30 s | same per-symbol fan-out as Monitor, no hidden-tab pause |
| 4 | **Anomalies** (`factors.js`) | ~121 per visit | 41 charts + 40 timeseries + 40 quoteSummary; memory cache is per tab |
| 5 | **Screener (stocks)** (`screener.js:114`) | 50 per scan | per-symbol |
| 6 | **Charts, stock symbol** | ~9–12 on load (+3 self-calls inside `/api/bias` if uncached), then 1 per 10–60 s | candles + 6-timeframe bias ladder + quoteSummary + bias + tail poll |
| 7 | **Map** (`WorldMap.jsx`) | ~4–5/min | `/api/world` fetched three times for the same blob |
| 8 | **Arena** (`Arena.jsx:331`) | 6/min | 2 routes every 20 s, keeps polling in hidden tabs |
| 9 | **Board** (`Board.jsx:429`) | 1/min + server fan-out | each POST can trigger up to 12 reads, several of them self-fetches |
| 10 | **News** | ~1.4/min | `/api/news` 90 s + `/api/telegram` 120 s (lightweight per call, but see 2b) |

The digest Worker adds a fixed ~10 + N(subscribers) per day, which is negligible.

### 2b. Parsing inside a Worker (the 10 ms CPU limit)

CPU time excludes waiting on `fetch`, so only parse/compute work counts. None of
this is measured yet. The order below is a suspicion, and the first step of the
plan is to measure it.

| Risk | Where | Work done in the isolate |
|---|---|---|
| **High** | `functions/api/news.js:293` (every edge-cache miss, i.e. ~every 90 s per colo, plus each self-call from `bias`/`briefing`/`board`) | regex-parse 15 RSS documents (often 50–300 KB each), decode entities, sort ~1k items, stringify |
| **High** | `functions/api/bvol.js:104` (cron sync) | unzip up to 7 daily archives and sample a row-per-second CSV (~86k rows/day) |
| **High** | `functions/api/vol.js:83` (cron sync) | 4 × 1000-row DoltHub JSON pages → build and stringify a ~2.3k-symbol blob |
| Medium | `functions/api/telegram.js:129` (cache miss, ~every 120 s per colo) | regex-parse 7 HTML pages |
| Medium | `functions/api/vol.js:143-187` (**every GET**, `no-store`) | JSON.parse the whole snapshot blob, then scan or sort 2.3k entries |
| Medium | `functions/api/briefing.js`, `bias.js`, `ask.js`, `board.mjs` | prompt assembly, candidate matching over the news pool, JSON re-parse of self-fetched responses |
| Low (measured) | `argus.js:35` | 171 KB parse + stringify, 0.5–1.5 ms (docs/BOARD.md) |
| Low | `yahoo`, `adsb`, `lse` | pass-through |

---

## 3. Failing source → blank panel or wrong number (not stale-but-labelled)

**Wrong numbers** (the worst class: it looks valid)

1. **Portfolio totals.** `src/pages/Portfolio.jsx:226-228`: `totalValue` sums `value ?? 0`, but `totalCost` includes every open position. One failed quote counts that position as worth $0, so account value and total P&L show a fake loss.
2. **Dashboard equity curve.** `src/pages/Dashboard.jsx:423-430` + `combineSeries` `:304`: failed symbols are silently dropped. Watchlist mode still weights by `100 / list.length`, so the index level is wrong. Portfolio mode understates value. There is no "n of m loaded" note.
3. **Accruals and short-interest quintiles.** `src/lib/factors.js:283,348` use plain `fetch` (no `fetchRetry`). A 429 is filed as "No usable fundamentals" / "No short data" (`Anomalies.jsx:368,439`, mislabelled), quintiles are re-cut over the survivors, and the partial result is cached for 15 min (`factors.js:46`).
4. **Crypto screener filters.** `src/lib/screener.js:92,96`: a failed kline fetch sets RSI/SMA to null, so the row silently fails "oversold"/"above SMA" filters. Unlike the stock scan, there is no `unreachable` list.
5. **Gaps in stock intraday candles.** `src/lib/data.js:216-217`: a failed chunk is swallowed, so the series has a hole. Indicators and backtests run across it with no warning.
6. **Day change across a null bar.** `src/lib/quotes.js:45-54` (same pattern in `screener.js:121-133`): nulls are filtered *before* picking the last two closes. If today's daily close is null while `regularMarketPrice` is live, `changePct` is measured against the day before yesterday.

**Blank, or silently empty**

7. **Monitor / Watchlist / Portfolio quotes.** `quotes.js:139,144,157` → `Monitor.jsx:42,50`: a failed symbol renders "–". The last good price is dropped once the 30 s client cache expires, instead of being kept with its age.
8. **Dashboard watchlist card.** `Dashboard.jsx:45-46` keeps the previous value on a failed tail, but with **no** age marker (stale but unlabelled). On a first-load failure the card is just missing (`allSettled` drops it).
9. **Dashboard lab and Argus panels.** `Dashboard.jsx:106,354`: any error sets null and the panel is hidden.
10. **News headlines.** `functions/api/news.js:338` returns `{items:[], error}` with no last-good copy, because only successes are edge-cached and nothing persists. `News.jsx:438` then blanks the list on a first-load failure.
11. **Telegram OSINT.** `functions/api/telegram.js:129-141`: when all 7 channels fail it returns `ok:true, items:[]` and **caches that for 120 s**. `News.jsx:332` then renders `null`, so the panel disappears, and the map loses its OSINT pins (`geoNews.js:69`).
12. **Map news pins.** `geoNews.js:61-71`: both feeds down means zero pins and no message.
13. **Map fires / conflicts / jamming / projects / quakes / satellites.** `WorldMap.jsx:451,470,594,614,633`, `satellites.js:24`: on `!ok` the layer is empty, which reads as "no fires today". The snapshots carry `at`, but these layers never show it. Fires expire from KV after 2 h (`fires.js:38`), at which point the layer goes blank. Only disasters (`WorldMap.jsx:495`) surfaces an outage.
14. **Ships and planes.** `world.js:40` has a 30 min KV TTL. Once the agent has been down that long the GET 404s and the UI says "fleet agent warming up…" (`WorldMap.jsx:364,401`), which is the wrong label. Vessels are also pruned after 10 min (`WorldMap.jsx:22,655`), so the map is blank while the status line says "stale".
15. **Arena and Kronos.** `Arena.jsx:321-322`: `.catch(() => null)` gives a blank page section.
16. **Options chain, fundamentals, LSE macro.** `options.js:90`, `fundamentals.js:18`, `macro.js:15`: these throw and the page shows an error instead of the last good chain or curve. That is acceptable for an arbitrary symbol, but a blank panel for the default ones.

**Already doing it right** (the pattern to copy): `/api/vol` + `Volatility.jsx:129,285`
(`stale` flag), `/api/bvol` + `CryptoOptionsPanel.jsx:87-98,268-284` (age and stale
warning), `/api/news` `meta.feeds[].status` (per-feed live/stale/down), and the
stock screener's / BAB's `unreachable` list.

---

## 4. Phased refactor plan (proposal — no code written)

Target end-state: **public reads are static files** (free, unlimited, CDN-cached)
produced on a schedule by a job that does all fetching and parsing. Every payload
carries `{ asOf, source, status }`. The browser keeps the last good copy and
labels its age. Functions remain only for writes, auth, admin/private data, LLM
calls, and live lookups of symbols outside the precomputed universes.

### Phase 0 — Measure (no code)
- Export 7 days of Pages analytics: requests and CPU time p50/p99 **per route**. This confirms or reorders sections 2a/2b.
- Set a budget, e.g. "public reads ≤ 20k/day at N daily visitors".

### Phase 1 — Quick wins inside today's architecture (one small PR each)
1. **Smallest first step:** `Dashboard.jsx:95-111` `useLabState` stops polling after a 401. Home-page behaviour is otherwise unchanged; every public home tab saves 1,440 invocations/day.
2. Fetch `/api/world` once on the map and share it between the ships, planes and jamming layers (3 → 1).
3. Batch stock quotes: `quotes.js` uses Yahoo `v8/finance/spark?symbols=…` (already allowed by the proxy's `v8/finance/` prefix). Monitor goes from 28 calls to 1–2 per poll; Watchlist and Portfolio benefit too. *Verify spark still serves multi-symbol 5d/1d first.*
4. Pause polling in hidden tabs on Monitor, Watchlist, Portfolio and Arena.
5. Stop caching all-failed results (`telegram.js:141`).
6. Delete or leave dead `Planes.jsx` / `Ships.jsx` (your call).

### Phase 2 — Freshness contract + honest failure UI
1. One shared helper/hook: `{ data, asOf, source, status: live | stale | down }`, keeping the last good value in memory and `localStorage`, plus one `<DataAge>` badge component.
2. Fix the wrong-number cases from section 3 (#1–#6): partial-coverage notes, `fetchRetry` in accruals/short, "n of m" on the equity curve, exclude-and-label in Portfolio totals, flag intraday gaps, null-safe day change.
3. Put the badge on every panel in section 3 (#7–#16), and replace "warming up" with the snapshot's real age.

### Phase 3 — Static snapshots for slow data (daily / hourly)
- A scheduled producer writes JSON to a static location. The browser reads `/data/<name>.json` first and falls back to the live proxy only for symbols outside the universe.
- Candidates: EOD candles and day-change for the fixed universes (Monitor 28, screener 50, factor 41, default watchlist), fundamentals, short interest, accruals, BAB inputs, the IV snapshot (instead of a D1 GET), BVOL history, LSE yields/calendar, projects, conflicts, satellites, disasters, the vendored geo files (already static).
- The vol/BVOL syncs move from Pages Functions into the producer, which removes the two worst CPU risks.

### Phase 4 — Static snapshots for fast data (1–5 min)
- Same producer at a higher cadence: Monitor/Dashboard quotes, news (parsed by the producer, never in a Worker), Telegram, world/fires/jamming, and the public Argus/Arena/Kronos views.
- `/api/news` and `/api/telegram` become fallbacks or are retired. The PC agents write to the static store directly, so the KV snapshot POST routes can go.

### Phase 5 — Shrink Functions to what must be dynamic
- Keep: auth, prefs, library/lab/ML (admin), `generate`, `ask`, the WS relay, and the Yahoo/LSE proxies for arbitrary symbols (rate-limited).
- Precompute `bias` notes and the `briefing` nightly for the universe. Remove the self-fetch chains in `bias`, `briefing` and `board`; they read the static snapshots instead.

### Phase 6 — Guardrails and cleanup
- A test or CI check that fails if a page issues more than N `/api/*` calls on load (puppeteer is already a dev dependency via `scripts/smoke.mjs`).
- Remove obsolete KV/D1 snapshot keys and routes. Update CLAUDE.md and the docs.

## 5. Decisions (2026-10-17) and Phase 1 status

### Phase 1 PRs (one per item, reordered: correctness before performance)
| # | PR | Status |
|---|---|---|
| 1 | Stop `/api/lab` polling for non-admin visitors (#1) | open |
| 2 | Failed quote ≠ $0: Portfolio stale/excluded totals, equity-curve weighting, crypto-screener "not checked" (#2) | open |
| 3 | Batch quotes via `v7/finance/quote`, spark for sparklines only, Monitor 60 s, pause polling in hidden tabs | **built, not committed**: waiting on a live check against Yahoo (`scripts/verify-yahoo-batch.mjs`); the build sandbox can't reach Yahoo |
| 4 | Negative caching: all-failed `/api/telegram` and `/api/news` cached 20 s (#3) | open |
| — | Dedupe `/api/world` on the map; delete dead `Planes.jsx` / `Ships.jsx` | not started |
| — | Remaining wrong-number cases: accruals/short quintiles, intraday chunk gaps, day change across a null bar | not started |

### Does anything fall back to a second source when Yahoo fails?
**No.** Confirmed from the code:
- `src/lib/data.js` `fetchYahoo` / `fetchYahooIntraday` / `fetchOlderCandles`: Yahoo only. A failure throws (or, for intraday chunks, is swallowed).
- `src/lib/lse.js` (London Strategic Edge) is a **manual** source picked in Backtest (`Backtest.jsx:433`, `dataSrc === "london"`), never an automatic fallback.
- `src/lib/quotes.js` falls back the *other* way: IBKR (dev only) → Yahoo.
- The only real upstream failover in the codebase is `/api/adsb` (adsb.lol → airplanes.live).

**Where a Stooq EOD fallback plugs in**:
1. **Now (browser path):** `fetchCandles` in `src/lib/data.js`, only in the daily/weekly/monthly branches (`isMaxDaily` and the final `else`). Stooq has no intraday data, so the sub-hour and 60m branches stay Yahoo-only. Wrap `fetchYahoo(...)` as "try Yahoo; on a transport/5xx/429 error, try Stooq", and stamp the result with `source` so the chart can say "EOD via Stooq".
   - Stooq sends no CORS headers, so this needs a small proxy (`functions/api/stooq/[[path]].js`, CSV → candle JSON, same 5-min edge cache as below).
   - Symbol mapping needed: `AAPL` → `aapl.us`, `^GSPC` → `^spx`, `EURUSD=X` → `eurusd`.
   - Before relying on it, verify that Stooq's CSV download still works without a key; it has added friction for automated clients before.
2. **Phase 3 (preferred):** in the GitHub Actions EOD producer. Yahoo first, Stooq on failure, and the source is written into the snapshot. The browser then never needs the fallback for the fixed universes.
3. Not a candidate: `quotes.js` intraday prices. Stooq has no live quotes.

### Snapshots: GitHub Actions primary, PC agents failover only
The producer runs in Actions; the PC agents push the same snapshot format only when the Actions copy is stale (each snapshot carries `asOf` + `producer`, so the reader can tell which one it got).

**Cannot run in Actions** (needs a persistent connection, a long-lived stateful loop, or local hardware), so these stay on an always-on process:

| Source / agent | Why | Where it lives |
|---|---|---|
| aisstream.io ships (`ais-agent.mjs:28`, `/api/ais-stream`) | WebSocket that must stay connected; positions are a stream, not a pull | PC, or a Durable Object (to evaluate) |
| Binance order book for Arena (`arena-agent.mjs:94`, `bookTicker` WS) | live depth stream; paper fills need every tick | PC |
| Telegram MTProto (`telegram-mtproto.mjs`) | authenticated session client; re-logging in from rotating CI IPs risks the account | PC. The public `t.me/s` scrape is plain HTTP and **can** run in Actions |
| Argus / Lab / executor / agent-daemon loops | 24/7 stateful loops (minutes cadence, open positions, command queue) | PC |
| Kronos forecasts (`scripts/kronos/`) | PyTorch model, local CPU/GPU | PC |
| Local LLM via OmniRoute (statements, research) | localhost service | PC (or switch to a hosted free tier) |

**Can run in Actions** (plain scheduled HTTP pulls): Yahoo EOD/fundamentals, Stooq, FRED/ALFRED, SEC EDGAR, CFTC COT, FINRA, the RSS feeds, `t.me/s` scrape, DoltHub IV, data.binance.vision BVOL archive, FIRMS, UCDP, GDACS, World Bank, CelesTrak, adsb.lol/airplanes.live sweeps.

**Must be verified from a real Actions runner before relying on it:**
- **Binance:** `api.binance.com` and `eapi.binance.com` geo-block US IPs (HTTP 451), and GitHub-hosted runners are mostly US. Binance spot/options may need to stay on the PC, or go through `data-api.binance.vision` for spot.
- **Yahoo:** it throttles cloud IP ranges.

### Storage: committed JSON for daily, R2 for intraday
- **Daily** snapshots are committed under `public/data/…` and deployed by the normal Pages build.
  - One commit per day, so well under the Pages Free build cap (~500/month).
  - **Repo size guard** (Phase 3, with the first producer): a CI check fails the job if the snapshot tree exceeds a budget (proposal: 50 MB total, 2 MB per file), or if a single commit adds more than 5 MB.
  - Snapshots are overwritten in place, not appended per day, so git history is the archive. A file that would need per-day history (e.g. `briefing/YYYY-MM-DD.json`) goes to R2 instead.
- **Intraday** snapshots go to an R2 bucket on its **public custom domain** (e.g. `data.quant.mmmxcix.com`). It is never fronted by a Worker, because any Worker in that path is an invocation per read again.
  - Needs: a bucket CORS rule for `quant.mmmxcix.com`, a `connect-src` entry in `public/_headers`, and an R2 API token in the Actions secrets.

### Arbitrary symbols: proxy + 5-min edge cache keyed by symbol
For symbols outside the precomputed universes:
- `/api/yahoo` keeps serving them.
- The response is cached at the edge for 5 min **keyed by symbol + endpoint + range/interval**, so only the first request per window reaches Yahoo.
- Anonymous callers get cached-or-stale: on a cache miss during an upstream failure they get the last cached copy marked stale, never a live call on their own.

Note this caps **Yahoo** calls, not **Function invocations**. Each request still runs the Function, because the cache lookup happens inside it. Getting a cache hit served before the Function runs needs a zone Cache Rule in front of Pages, which has to be verified. Phase 5.

### Measurement before Phase 3
Required: measured per-route request counts and CPU time, not estimates. This could not be done from the build session: it has no Cloudflare analytics access, and its network policy blocks Cloudflare and Yahoo. What it takes:
- **Requests per route:** the zone's `httpRequestsAdaptiveGroups` (GraphQL Analytics API) grouped by `clientRequestPath` for `quant.mmmxcix.com/api/*`, over 7 days. Needs an API token with *Account Analytics: Read* + *Zone Analytics: Read*.
- **CPU per route:** Cloudflare's Workers/Pages analytics report CPU time per **script**, not per path, so per-route CPU needs either Workers Logs/Logpush with per-invocation CPU and the URL, or a temporary `performance.now()`-style marker logged per route (wall time, not CPU, so it is only an upper bound). Logs are the accurate option.
- Next step: provide that token as a session secret (or run the query yourself) and the numbers will be added here.

### Briefing (reserved, not built)
See `docs/BRIEFING.md`. Paths and stubs are created in Phase 3/4, together with the producer.

### Decisions that were needed before Phase 3 (answered in section 5)
1. **Producer:** your PC agents (already running, but they stop when the PC is off), GitHub Actions cron (independent of the PC; Yahoo may throttle its IPs; free minutes depend on repo visibility), or both with failover.
2. **Static store:** (a) commit JSON and let Pages rebuild, which is fine for daily data but the Pages Free build cap (~500/month) rules it out for 5-min data; or (b) an R2 bucket on a public custom domain, which serves reads without any Worker invocation and fits the fast data. Verify the current R2 free-tier numbers and CORS setup. My recommendation is **(a) for daily data and (b) for intraday**.
3. Should arbitrary-symbol live charts stay on the proxy, or be limited for anonymous users?
