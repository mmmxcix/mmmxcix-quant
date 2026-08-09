// scanUniverse.js — the market universe the "Find best market" scanner sweeps a
// strategy across. Curated to the liquid, famous instruments a trader actually
// uses, grouped by class so you can include/exclude whole classes. ~180 symbols.
//
// market: "crypto" → Binance (SYMBOLUSDT); "stock" → Yahoo (equities, ETFs, and
// FX via the =X suffix). label is what the UI shows.

// Tickers follow Binance renames: MATIC→POL (Sep 2024), RNDR→RENDER (Jul 2024),
// FTM→S (Sonic, Jan 2025) — the old pairs are delisted and error every scan.
const crypto = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK", "POL", "LTC",
  "BCH", "ATOM", "UNI", "XLM", "ETC", "FIL", "APT", "ARB", "OP", "NEAR", "INJ", "SUI",
  "SEI", "TIA", "RUNE", "AAVE", "MKR", "LDO", "IMX", "RENDER", "S", "ALGO", "VET", "HBAR",
  "GRT", "SAND", "MANA", "AXS", "PEPE", "SHIB", "WIF", "TON", "TRX",
].map((c) => ({ symbol: `${c}USDT`, market: "crypto", label: `${c}/USDT`, cls: "crypto" }));

const stocks = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "JPM", "V", "MA", "UNH",
  "XOM", "WMT", "LLY", "ORCL", "HD", "CVX", "MRK", "ABBV", "KO", "PEP", "COST", "ADBE",
  "CRM", "AMD", "NFLX", "INTC", "CSCO", "QCOM", "TXN", "AMAT", "MU", "BA", "CAT", "GE",
  "DIS", "PYPL", "SHOP", "UBER", "ABNB", "COIN", "PLTR", "SNOW", "NKE", "MCD", "SBUX",
  "PFE", "BAC", "WFC", "GS", "MS", "C", "T", "VZ", "TMUS", "PG", "JNJ", "SMCI", "MSTR",
].map((s) => ({ symbol: s, market: "stock", label: s, cls: "stock" }));

const etfs = [
  "SPY", "QQQ", "IWM", "DIA", "VTI", "VOO", "GLD", "SLV", "USO", "UNG", "TLT", "IEF",
  "HYG", "LQD", "XLE", "XLF", "XLK", "XLV", "XLY", "XLI", "XLP", "XLU", "XLB", "XLRE",
  "SMH", "SOXX", "ARKK", "EEM", "EFA", "VNQ", "GDX", "DBC", "BITO", "TQQQ", "SQQQ",
].map((s) => ({ symbol: s, market: "stock", label: s, cls: "etf" }));

const forex = [
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCHF", "USDCAD", "NZDUSD", "EURGBP",
  "EURJPY", "GBPJPY", "USDCNY", "USDMXN", "USDZAR", "USDTRY", "EURCHF", "AUDJPY",
].map((s) => ({ symbol: `${s}=X`, market: "stock", label: s, cls: "forex" }));

export const SCAN_UNIVERSE = [...crypto, ...stocks, ...etfs, ...forex];

export const SCAN_CLASSES = [
  { id: "crypto", label: "Crypto", n: crypto.length },
  { id: "stock", label: "Stocks", n: stocks.length },
  { id: "etf", label: "ETFs", n: etfs.length },
  { id: "forex", label: "Forex", n: forex.length },
];

// A Yahoo/Binance range that yields a healthy bar count for each timeframe, so a
// scan has enough history to be meaningful without over-fetching.
export const SCAN_RANGE = {
  "1M": "max", "1w": "max", "1d": "10y", "4h": "2y", "2h": "2y",
  "1h": "2y", "30m": "1mo", "15m": "1mo", "5m": "1mo", "1m": "7d",
};
