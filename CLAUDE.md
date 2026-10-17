# mmmxcix-quant

Quant trading tool at https://quant.mmmxcix.com. Part of the mmmxcix family:
`casino.mmmxcix.com` (casino), `mmmxcix.com` (portfolio, reserved).

> Full outbound-call inventory, free-tier hotspots and failure-mode list:
> `docs/STATIC_FIRST_AUDIT.md`. Read it before adding any new data source.

## Context navigation
When you need to understand the codebase or any files in this project:
1. ALWAYS query the knowledge graph first: `/graphify query "your question"`
2. Only read raw files if I explicitly say "read the file" or "look at the raw file"
3. The graph lives in `graphify-out/graph.json`; `graphify-out/GRAPH_REPORT.md` has the community map and god nodes; `graphify-out/obsidian/` is the Obsidian vault
4. After files change, refresh the graph with `/graphify . --update` (incremental) before relying on it
5. `graphify-out/` is gitignored. It is a local navigation tool, not part of the deployed app (a fresh clone has none, so fall back to reading files)

## Stack
- **Frontend**: React 18 SPA, Vite 6, Tailwind 3, react-router 6, lightweight-charts 4 (TradingView), lucide-react. Pyodide (from cdn.jsdelivr.net, opt-in) for Python strategies. satellite.js for SGP4 propagation.
- **Hosting**: Cloudflare Pages, project `mmmxcix-quant`, **Free plan** (100k Function requests/day, 10 ms CPU per invocation, 50 subrequests per invocation, KV 1k writes/day, D1 100k writes/day).
- **Server code**: Pages Functions in `functions/` (workerd, no npm deps besides better-auth/kysely-d1). Every `/api/*` request is one Function invocation, **even when the Function answers from `caches.default`**. Only static files in `public/` and `dist/assets` are free and unlimited.
- **Bindings** (set in the Pages dashboard, there is no Pages wrangler.toml): `DB` = D1 `mmmxcix-quant-auth` (tables `argus_kv` blob store, better-auth, board/insider/statements, `backtest_jobs`); `SUBSCRIBERS` = KV (newsletter, lab:*, ml:*, fleet snapshots).
- **Secrets**: `DEV_ACCESS_TOKEN` (machine token for the PC agents), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DEV_EMAIL`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `ANTHROPIC_API_KEY`, `LSE_API_KEY`, `AISSTREAM_KEY`, `RESEND_API_KEY`. Worker only: `DIGEST_FROM`, `DIGEST_TEST_TOKEN`, `DEV_ACCESS_TOKEN`.
- **Standalone Worker**: `workers/digest-worker.js` (`quant-digest`), cron `0 6 * * *`. Sends the email digest and triggers the nightly `/api/vol` and `/api/bvol` syncs.
- **PC agents** (`scripts/*.mjs`, run 24/7 on the owner's machine): fetch sources that Cloudflare can't or shouldn't reach (Binance eapi, SEC EDGAR, FIRMS, UCDP, GDACS, CelesTrak, adsb, AIS, Telegram MTProto, LLM via local OmniRoute) and **push** snapshots to `/api/*` with `DEV_ACCESS_TOKEN`.
- **Auth**: better-auth on D1 (`functions/api/auth/[[path]].js`, `functions/_lib/auth.mjs`). "Admin" = the dev account. Most private routes accept admin cookie OR machine token.

## Folder structure
```
src/
  main.jsx, App.jsx          routes (hubs: /backtest/:tab, /portfolio/:tab, /news/:tab, /screener/:tab, /macro/:tab, /learn/:tab, /cortex/:tab)
  pages/                     one file per page; pages/hub/* = tabbed hubs
  components/                shared UI (CandleChart, Surface3D, Heatmap, BiasSection, ...)
  lib/                       all data access + quant math (pure where possible)
    data.js                  candles: Binance REST (browser) + /api/yahoo v8 chart
    quotes.js, liveStream.js snapshot quotes; Binance WS live ticks
    screener.js, factors.js  universe scans (fan out one request per symbol)
    backtest.js, strategies.js, indicators.js   backtest engine (signal on close, fill next open, fees in bps)
    argus/ board/ insider/ polymarket/ statements/   agent + feature modules
functions/
  api/*.js                   one Pages Function per route (see audit doc for each)
  api/yahoo/[[path]].js      Yahoo allowlist proxy (v8 chart, v1 search, v7 options, v10 quoteSummary w/ crumb, ws/ fundamentals)
  api/lse/[[path]].js, api/adsb/[[path]].js   keyed / CORS proxies
  _lib/                      shared server helpers (auth, ratelimit, snapshot handler, board loader, bvol/zip)
workers/                     quant-digest cron Worker (+ wrangler.toml)
scripts/                     PC agents, relays, backfills, build helpers (smoke, a11y, shots, og)
public/                      static assets: _headers (CSP!), _redirects (SPA), sw.js (no-cache SW), vendored geo JSON (world-*.json, cables, powerplants, pipelines, mines, oilrigs)
db/                          D1 schema files
docs/                        design notes, findings, runbooks
test/                        node:test suites (`npm test`)
```

## Commands
```
npm install
npm run dev          # vite on :5173; dev proxy for /api/yahoo (+ crumb handshake at start), dev middlewares for /api/bvol and /api/binance-options. Other /api/* routes do NOT exist in dev.
npm test             # node --test
npm run build        # -> dist/
npm run check        # tests + build + smoke + a11y (run before pushing)
```
Deploy:
- **Site**: push to `main`, Cloudflare Pages auto-builds (`npm run build`, output `dist`). Never push to `main` without being asked.
- **Digest worker**: `cd workers && npx wrangler deploy` (secrets via `npx wrangler secret put NAME`).
- **D1 schema**: `npx wrangler d1 execute mmmxcix-quant-auth --remote --file db/<file>.sql`
- **BVOL first fill**: `node scripts/bvol-backfill.mjs --push`

## Third-party data sources
Where it runs: **B** = browser, **F** = Pages Function, **W** = digest Worker (cron), **PC** = local agent pushing to the site. Nothing is fetched at build time.

| Source | Used for | Runs | Key |
|---|---|---|---|
| Binance spot REST `api.binance.com/api/v3` | crypto klines, 24h tickers, exchangeInfo, screener | B (also F in board.mjs, W, PC) | none |
| Binance futures `fapi.binance.com` | funding-rate history for backtests | B | none |
| Binance WS `stream.binance.com:9443` | live kline/aggTrade/book on Charts | B | none |
| Binance options `eapi.binance.com` | options overview (no CORS, 403 from CF) | PC relay → `/api/binance-options` (D1) | none |
| Binance archive `data.binance.vision` | BVOL index daily ZIPs | F (`/api/bvol` sync, cron-triggered) + PC backfill | none |
| Yahoo Finance `query1.finance.yahoo.com`, `fc.yahoo.com` | stock/ETF/index/FX candles, quotes, search, option chains, quoteSummary, fundamentals timeseries | F (`/api/yahoo`), called from B, W and other F | none (crumb) |
| London Strategic Edge `data-api.londonstrategicedge.com` | bond yields, economic calendar, alt candles | F (`/api/lse`) | `LSE_API_KEY` |
| DoltHub `post-no-preference/options` | IV rank / IV history snapshot | F (`/api/vol` sync, cron-triggered) | none |
| 15 RSS feeds (Fed, SEC, BLS, BBC, Guardian, NPR, CNBC, Yahoo, CoinDesk, MarketWatch, Investing.com, Cointelegraph, 3× PR Newswire) | news | F (`/api/news`) | none |
| Telegram `t.me/s/<channel>` (7 channels) | OSINT feed | F (`/api/telegram` scrape) or PC MTProto push | none / MTProto session on PC |
| USGS `earthquake.usgs.gov` | quake layer | B | none |
| Frankfurter `api.frankfurter.dev` (ECB) | FX for portfolio deposits | B | none |
| adsb.lol, airplanes.live, adsbdb.com | aircraft, routes | F (`/api/adsb`) + PC → `/api/world` | none |
| aisstream.io | ships | F WebSocket relay (admin) + PC → `/api/world` | `AISSTREAM_KEY` |
| NASA FIRMS, UCDP, GDACS, World Bank, CelesTrak | map layers | PC → `/api/fires`, `/conflicts`, `/disasters`, `/projects`, `/satellites` (KV) | FIRMS key on PC |
| SEC EDGAR | Form 4 insider data | PC → `/api/insider` (D1) | none (UA required) |
| Polymarket (goldsky subgraph, Polygon RPC) | research | PC | none |
| Groq, Gemini (free pool) | bias note, briefing, ask | F | `GROQ_API_KEY`, `GEMINI_API_KEY` |
| Anthropic, Mistral (+ Groq, Gemini) | strategy generator (admin) | F (`/api/generate`) | keys |
| Resend | confirmation + digest mail | F (`/api/subscribe`), W | `RESEND_API_KEY` |
| cdn.jsdelivr.net | Pyodide + wheels | B (opt-in) | none |
| localhost:5000 IBKR Client Portal, local OmniRoute | dev-only live quotes / local LLM | B (owner's machine only) | none |

Adding a browser-side host means adding it to `connect-src` in `public/_headers`, or it fails with a bare "Failed to fetch".

## Architecture notes
- **Candle format**: `{ time: unix SECONDS, open, high, low, close, volume }`, ascending.
- **Push model**: Cloudflare can't reach the home network, so the PC always initiates. Snapshot routes share `functions/_lib/snapshot.js` (POST with token → KV, GET → raw blob). Agent state lives in D1 `argus_kv` (one JSON blob per key), because KV's 1k writes/day ran out.
- **Anomalies** (`/screener/anomalies`): BAB, accruals, short interest (`src/lib/factors.js`, 40-stock universe), correlation regimes, drawdown topology, Greeks manifold. 3D via `Surface3D.jsx` (canvas, dependency-free).
- **Universe scans** must use `fetchRetry` + `mapLimit` from `src/lib/netRetry.js` and report `unreachable` separately from "no data".
- **Glass look**: pure CSS (`src/glass.css`): `.lg-glass`, `.lg-frost`, `.ambient-bg`. The WebGL liquidGL lib from the casino was deliberately REMOVED (commit ec74ecb: smeared dropdowns, too much RAM). Do not reintroduce it without asking.
- **Design tokens** (tailwind.config.js): bg #0a0e14, surface, line, text, dim, accent #2dd4bf, up, down; utilities `.input-base`, `.btn-accent`, `.chip*` in src/index.css. See DESIGN.md.
- **Service worker** never caches (stale-chunk incidents). Never add a root `public/404.html` (it breaks SPA deep links, see `public/_redirects`).

## Static-first rules (decided 2026-10-17, see `docs/STATIC_FIRST_AUDIT.md` §5)
- Scheduled snapshots: **GitHub Actions is primary**, PC agents are failover only. Sources that need a persistent connection (aisstream, Binance book WS, Telegram MTProto, the 24/7 agent loops, Kronos) stay on an always-on process.
- **Binance never goes into Actions** (US runners, Binance geo-blocks US IPs): Binance pulls stay on the PC agents. Browser-side Binance calls are unaffected.
- Daily snapshots = committed JSON (with a repo size guard). Intraday = R2 on its **public custom domain, never behind a Worker**.
- Arbitrary symbols stay on `/api/yahoo` with a 5-min edge cache per symbol; anonymous users get cached-or-stale.
- API keys live only in Actions/Cloudflare secrets. The browser never calls a keyed source (FRED etc.) directly.
- Every panel shows source + as-of. A failing source yields "stale/down, as of …", never a blank or a wrong number.
- New polling uses `visibleInterval` (`src/lib/visiblePoll.js`) so hidden tabs don't spend Function invocations.

## Planned
Static-first data refactor (see `docs/STATIC_FIRST_AUDIT.md`), daily briefing built from the snapshots (`docs/BRIEFING.md`, reserved, not built), saved strategies, parameter optimisation, IBKR integration, AI strategy generator via the Anthropic API behind a paywall.
