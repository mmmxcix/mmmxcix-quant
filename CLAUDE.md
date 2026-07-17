# mmmxcix-quant

Quant-Trading-Tool auf https://quant.mmmxcix.com (Cloudflare Pages, Projekt `mmmxcix-quant`, Auto-Deploy bei Push auf `main`). Teil der mmmxcix-Familie: `casino.mmmxcix.com` (Casino), `mmmxcix.com` (Portfolio, reserviert).

## Context Navigation
When you need to understand the codebase or any files in this project:
1. ALWAYS query the knowledge graph first: `/graphify query "your question"`
2. Only read raw files if I explicitly say "read the file" or "look at the raw file"
3. The graph lives in `graphify-out/graph.json`; `graphify-out/GRAPH_REPORT.md` has the community map and god nodes; `graphify-out/obsidian/` is the Obsidian vault
4. After files change, refresh the graph with `/graphify . --update` (incremental) before relying on it
5. `graphify-out/` is gitignored — it is a local navigation tool, not part of the deployed app

## Architektur-Kurzreferenz
- **Stack**: React 18 + Vite + Tailwind, lightweight-charts (TradingView), kein Backend-Server
- **Daten**: Krypto direkt von Binance (Browser-CORS ok); Aktien via `/api/yahoo/*` (Cloudflare Pages Function `functions/api/yahoo/[[path]].js` in Prod, vite-Proxy in Dev); News via `functions/api/news.js` (RSS-Aggregation, 6 Feeds)
- **Backtest**: `src/lib/backtest.js` (runBacktest, compileStrategy), `src/lib/strategies.js` (6 Baukasten-Strategien), `src/lib/indicators.js` — Signale auf Bar-Close, Fill am nächsten Open (kein Look-Ahead), Gebühren in bps
- **Anomalies** (`/anomalies`, `src/pages/Anomalies.jsx`): 6 Quant-Module — BAB-Faktor-Backtest, Accruals- & Short-Interest-Screens (`src/lib/factors.js`, 40-Aktien-Universum), Korrelations-Regime (`src/lib/regimes.js`), Drawdown-Topologie (`simulateDrawdownTopology` in montecarlo.js), Greeks-Manifold (Black-Scholes aus options.js). 3D-Flächen via `src/components/Surface3D.jsx` (Canvas, dependency-frei), Korrelationsmatrizen via `Heatmap.jsx`. Dafür erlaubt der Yahoo-Proxy zusätzlich `v10/quoteSummary` (Crumb) und `ws/fundamentals-timeseries`; der vite-Dev-Proxy macht den Crumb-Handshake beim Serverstart
- **Candle-Format**: `{ time: unix-SEKUNDEN, open, high, low, close, volume }`, aufsteigend
- **Glass-Look**: rein CSS (`src/glass.css`) — `.lg-glass` = transluzente Panels mit backdrop-blur, `.lg-frost` = fixed Chrome (Sidebar/Header), `.ambient-bg` = dezenter Gradient dahinter. Die WebGL-liquidGL-Lib vom Casino wurde bewusst ENTFERNT (Commit ec74ecb: verschmierte Dropdowns, zu viel RAM) — nicht wieder einführen, ohne den User zu fragen
- **Design-Tokens** (tailwind.config.js): bg #0a0e14, surface, line, text, dim, accent #2dd4bf, up, down; Utility-Klassen `.input-base`, `.btn-accent`, `.chip*` in src/index.css

## Geplant (Ausbaustufen)
Strategien speichern (Supabase), Parameter-Optimierung, IBKR-Anbindung, KI-Strategie-Generator über Anthropic-API mit Paywall.
