// universe.js — the market monitor's instrument list, in one place.
//
// This used to be a `const PANELS` inside src/pages/Monitor.jsx, which was fine
// while a page was the only thing that wanted it. The board (src/lib/board) has to
// answer "what is the market doing" server-side, and a second copy of the list
// would drift from the first the day either changed. So the list moved here and
// the page imports it — the same reason /api/briefing serves both the digest
// mail and the News tab from one implementation.
//
// Quotes for these come from src/lib/quotes.js in the browser and from
// /api/board (market.quotes) on the server; both read THIS list.

export const PANELS = [
  {
    id: "indices",
    title: "Indices",
    entries: [
      { market: "stock", symbol: "^GSPC", name: "S&P 500" },
      { market: "stock", symbol: "^NDX", name: "Nasdaq 100" },
      { market: "stock", symbol: "^DJI", name: "Dow Jones" },
      { market: "stock", symbol: "^GDAXI", name: "DAX" },
      { market: "stock", symbol: "^SSMI", name: "SMI" },
      { market: "stock", symbol: "^N225", name: "Nikkei 225" },
      { market: "stock", symbol: "^FTSE", name: "FTSE 100" },
    ],
  },
  {
    id: "crypto",
    title: "Crypto",
    entries: [
      { market: "crypto", symbol: "BTCUSDT", name: "Bitcoin" },
      { market: "crypto", symbol: "ETHUSDT", name: "Ethereum" },
      { market: "crypto", symbol: "SOLUSDT", name: "Solana" },
      { market: "crypto", symbol: "BNBUSDT", name: "BNB" },
      { market: "crypto", symbol: "XRPUSDT", name: "XRP" },
      { market: "crypto", symbol: "DOGEUSDT", name: "Dogecoin" },
    ],
  },
  {
    id: "commodities",
    title: "Commodities",
    entries: [
      { market: "stock", symbol: "GC=F", name: "Gold" },
      { market: "stock", symbol: "SI=F", name: "Silver" },
      { market: "stock", symbol: "CL=F", name: "WTI Oil" },
      { market: "stock", symbol: "BZ=F", name: "Brent" },
      { market: "stock", symbol: "NG=F", name: "Natural Gas" },
      { market: "stock", symbol: "HG=F", name: "Copper" },
    ],
  },
  {
    id: "forex",
    title: "Forex",
    entries: [
      { market: "stock", symbol: "EURUSD=X", name: "EUR/USD" },
      { market: "stock", symbol: "GBPUSD=X", name: "GBP/USD" },
      { market: "stock", symbol: "USDJPY=X", name: "USD/JPY" },
      { market: "stock", symbol: "USDCHF=X", name: "USD/CHF" },
      { market: "stock", symbol: "EURCHF=X", name: "EUR/CHF" },
    ],
  },
  {
    id: "megacaps",
    title: "Mega Caps",
    entries: [
      { market: "stock", symbol: "AAPL", name: "Apple" },
      { market: "stock", symbol: "MSFT", name: "Microsoft" },
      { market: "stock", symbol: "NVDA", name: "NVIDIA" },
      { market: "stock", symbol: "GOOGL", name: "Alphabet" },
      { market: "stock", symbol: "AMZN", name: "Amazon" },
      { market: "stock", symbol: "META", name: "Meta" },
      { market: "stock", symbol: "TSLA", name: "Tesla" },
    ],
  },
  {
    id: "bonds",
    title: "Bonds / Vol",
    entries: [
      { market: "stock", symbol: "^TNX", name: "US 10Y Yield" },
      { market: "stock", symbol: "^FVX", name: "US 5Y Yield" },
      { market: "stock", symbol: "^VIX", name: "VIX Volatility" },
    ],
  },
];

export const ALL_ENTRIES = PANELS.flatMap((p) => p.entries);

export const PANEL_IDS = PANELS.map((p) => p.id);

/** The entries of one panel, or every entry for "all". */
export function panelEntries(id = "all") {
  if (id === "all") return ALL_ENTRIES;
  return PANELS.find((p) => p.id === id)?.entries || [];
}

/** Look up an instrument by ticker, so a caller may name symbols instead of a panel. */
export function findEntry(symbol) {
  const s = String(symbol || "").toUpperCase();
  return ALL_ENTRIES.find((e) => e.symbol.toUpperCase() === s) || null;
}
