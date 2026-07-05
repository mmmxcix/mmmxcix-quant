// Symbol search with name→ticker resolution.
//
// Stocks: Yahoo's search endpoint via the /api/yahoo/* proxy (Pages Function
// in production, vite dev-server proxy locally — same path as data.js).
// Crypto: Binance exchangeInfo fetched ONCE and cached module-level, plus a
// hardcoded name map so searches like "bitcoin" resolve to BTCUSDT without a
// network round-trip per keystroke. Debouncing is the caller's job.

const YAHOO_SEARCH = "/api/yahoo/v1/finance/search";
const BINANCE_EXCHANGE_INFO = "https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT";
const MAX_RESULTS = 8;

const STOCK_TYPES = new Set(["EQUITY", "ETF", "INDEX", "MUTUALFUND"]);

// Common name → base asset for the top coins (Binance base symbols).
const CRYPTO_NAMES = {
  bitcoin: "BTC",
  ethereum: "ETH",
  solana: "SOL",
  ripple: "XRP",
  dogecoin: "DOGE",
  cardano: "ADA",
  avalanche: "AVAX",
  polkadot: "DOT",
  chainlink: "LINK",
  polygon: "POL",
  litecoin: "LTC",
  tron: "TRX",
  shiba: "SHIB",
  uniswap: "UNI",
  stellar: "XLM",
  monero: "XMR",
  cosmos: "ATOM",
  near: "NEAR",
  aptos: "APT",
  arbitrum: "ARB",
  optimism: "OP",
  injective: "INJ",
  sui: "SUI",
  pepe: "PEPE",
  ton: "TON",
  toncoin: "TON",
};

// Reverse map: base asset → display name (first name wins, e.g. "ton" → Ton).
const CRYPTO_DISPLAY = {};
for (const [name, base] of Object.entries(CRYPTO_NAMES)) {
  if (!CRYPTO_DISPLAY[base]) {
    CRYPTO_DISPLAY[base] = name.charAt(0).toUpperCase() + name.slice(1);
  }
}

async function searchStocks(query) {
  const url = `${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=${MAX_RESULTS}&newsCount=0`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  const quotes = Array.isArray(json?.quotes) ? json.quotes : [];
  return quotes
    .filter((q) => q?.symbol && STOCK_TYPES.has(String(q.quoteType || "").toUpperCase()))
    .slice(0, MAX_RESULTS)
    .map((q) => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      exchange: q.exchDisp || q.exchange || "",
      type: q.quoteTypeDisp || q.quoteType || "",
    }));
}

// Cached { symbol: "BTCUSDT", base: "BTC" } list; the in-flight promise is
// cached too so parallel keystrokes share one request. Reset on failure so a
// later call can retry.
let cryptoListPromise = null;

async function loadCryptoList() {
  if (!cryptoListPromise) {
    cryptoListPromise = (async () => {
      const res = await fetch(BINANCE_EXCHANGE_INFO);
      if (!res.ok) throw new Error(`Binance-Fehler ${res.status}`);
      const json = await res.json();
      return (json?.symbols || [])
        .filter((s) => s.quoteAsset === "USDT" && s.status === "TRADING")
        .map((s) => ({ symbol: s.symbol, base: s.baseAsset }));
    })().catch((err) => {
      cryptoListPromise = null; // allow retry on next call
      throw err;
    });
  }
  return cryptoListPromise;
}

async function searchCrypto(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const list = await loadCryptoList();

  // Bases whose common name matches the query (e.g. "bitc" → BTC).
  const nameHits = new Set(
    Object.entries(CRYPTO_NAMES)
      .filter(([name]) => name.startsWith(q))
      .map(([, base]) => base)
  );

  const results = [];
  for (const { symbol, base } of list) {
    if (base.toLowerCase().startsWith(q) || nameHits.has(base)) {
      results.push({
        symbol,
        name: CRYPTO_DISPLAY[base] || base,
        exchange: "Binance",
        type: "Crypto",
        _exact: base.toLowerCase() === q || nameHits.has(base) ? 0 : 1,
      });
    }
  }
  // Exact/name matches first, then shorter bases (BTC before BTCDOM), then A–Z.
  results.sort(
    (a, b) =>
      a._exact - b._exact ||
      a.symbol.length - b.symbol.length ||
      a.symbol.localeCompare(b.symbol)
  );
  return results.slice(0, MAX_RESULTS).map(({ _exact, ...r }) => r);
}

// → Promise<[{ symbol, name, exchange, type }]>; never throws, resolves to []
// on any error so the UI can stay quiet.
export async function searchSymbols(query, market) {
  const q = (query || "").trim();
  if (!q) return [];
  try {
    return market === "crypto" ? await searchCrypto(q) : await searchStocks(q);
  } catch {
    return [];
  }
}
