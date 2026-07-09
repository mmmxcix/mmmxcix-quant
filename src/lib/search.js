// Symbol search with name→ticker resolution.
//
// Two tiers for speed:
//   localMatches()  — synchronous, zero-network: popular-name maps (stocks +
//                     crypto) and the cached Binance list. The component shows
//                     these instantly on every keystroke.
//   searchSymbols() — async full search (Yahoo for stocks, Binance list for
//                     crypto), merged with the local hits, result-cached per
//                     query so repeated keystrokes ("app" → "appl" → "app")
//                     never refetch.

const YAHOO_SEARCH = "/api/yahoo/v1/finance/search";
const BINANCE_EXCHANGE_INFO = "https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT";
const MAX_RESULTS = 10;

const STOCK_TYPES = new Set(["EQUITY", "ETF", "INDEX", "MUTUALFUND", "CURRENCY", "FUTURE"]);

// Popular stock/index names → Yahoo tickers: instant hits without a network
// round-trip. Includes the big US names plus Swiss/European favourites.
const STOCK_NAMES = {
  apple: ["AAPL", "Apple"],
  microsoft: ["MSFT", "Microsoft"],
  google: ["GOOGL", "Alphabet (Google)"],
  alphabet: ["GOOGL", "Alphabet (Google)"],
  amazon: ["AMZN", "Amazon"],
  tesla: ["TSLA", "Tesla"],
  nvidia: ["NVDA", "NVIDIA"],
  meta: ["META", "Meta Platforms"],
  facebook: ["META", "Meta Platforms"],
  netflix: ["NFLX", "Netflix"],
  amd: ["AMD", "Advanced Micro Devices"],
  intel: ["INTC", "Intel"],
  berkshire: ["BRK-B", "Berkshire Hathaway"],
  jpmorgan: ["JPM", "JPMorgan Chase"],
  visa: ["V", "Visa"],
  mastercard: ["MA", "Mastercard"],
  cocacola: ["KO", "Coca-Cola"],
  coke: ["KO", "Coca-Cola"],
  mcdonalds: ["MCD", "McDonald's"],
  disney: ["DIS", "Walt Disney"],
  boeing: ["BA", "Boeing"],
  nike: ["NKE", "Nike"],
  paypal: ["PYPL", "PayPal"],
  palantir: ["PLTR", "Palantir"],
  broadcom: ["AVGO", "Broadcom"],
  eli: ["LLY", "Eli Lilly"],
  novo: ["NVO", "Novo Nordisk"],
  nestle: ["NSRGY", "Nestlé"],
  novartis: ["NVS", "Novartis"],
  roche: ["RHHBY", "Roche"],
  ubs: ["UBS", "UBS Group"],
  zurich: ["ZURVY", "Zurich Insurance"],
  sap: ["SAP", "SAP"],
  siemens: ["SIEGY", "Siemens"],
  volkswagen: ["VWAGY", "Volkswagen"],
  porsche: ["POAHY", "Porsche SE"],
  asml: ["ASML", "ASML"],
  lvmh: ["LVMUY", "LVMH"],
  sp500: ["^GSPC", "S&P 500 Index"],
  spx: ["^GSPC", "S&P 500 Index"],
  nasdaq: ["^NDX", "Nasdaq 100 Index"],
  dow: ["^DJI", "Dow Jones Index"],
  dax: ["^GDAXI", "DAX Index"],
  smi: ["^SSMI", "SMI Index"],
  gold: ["GC=F", "Gold Futures"],
  silber: ["SI=F", "Silber Futures"],
  silver: ["SI=F", "Silber Futures"],
  oil: ["CL=F", "WTI Crude Oil"],
  euro: ["EURUSD=X", "EUR/USD"],
  spy: ["SPY", "SPDR S&P 500 ETF"],
  qqq: ["QQQ", "Invesco QQQ ETF"],
};

// Common name → base asset for the top coins (Binance base symbols).
const CRYPTO_NAMES = {
  bitcoin: "BTC",
  ethereum: "ETH",
  ether: "ETH",
  solana: "SOL",
  ripple: "XRP",
  xrp: "XRP",
  dogecoin: "DOGE",
  doge: "DOGE",
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
  bnb: "BNB",
  binancecoin: "BNB",
  hedera: "HBAR",
  filecoin: "FIL",
  render: "RENDER",
  fetch: "FET",
  algorand: "ALGO",
  vechain: "VET",
  sandbox: "SAND",
  decentraland: "MANA",
  aave: "AAVE",
  maker: "MKR",
  lido: "LDO",
  worldcoin: "WLD",
  bonk: "BONK",
  floki: "FLOKI",
  kaspa: "KAS",
  sei: "SEI",
  celestia: "TIA",
  jupiter: "JUP",
  ondo: "ONDO",
};

// Reverse map: base asset → display name (first name wins).
const CRYPTO_DISPLAY = {};
for (const [name, base] of Object.entries(CRYPTO_NAMES)) {
  if (!CRYPTO_DISPLAY[base]) {
    CRYPTO_DISPLAY[base] = name.charAt(0).toUpperCase() + name.slice(1);
  }
}

// ── Local (synchronous) matches — instant, zero network ─────────────────────

let cryptoListCache = null; // resolved [{symbol, base}] once loaded

export function localMatches(query, market) {
  const q = (query || "").trim().toLowerCase().replace(/[\s-]/g, "");
  if (!q) return [];

  if (market === "crypto") {
    const hits = [];
    const seen = new Set();
    for (const [name, base] of Object.entries(CRYPTO_NAMES)) {
      if ((name.includes(q) || base.toLowerCase().startsWith(q)) && !seen.has(base)) {
        seen.add(base);
        hits.push({ symbol: `${base}USDT`, name: CRYPTO_DISPLAY[base] || base, exchange: "Binance", type: "Crypto" });
      }
    }
    // Cached Binance list (if already loaded) for raw-ticker prefix hits.
    if (cryptoListCache) {
      for (const { symbol, base } of cryptoListCache) {
        if (base.toLowerCase().startsWith(q) && !seen.has(base)) {
          seen.add(base);
          hits.push({ symbol, name: CRYPTO_DISPLAY[base] || base, exchange: "Binance", type: "Crypto" });
        }
      }
    }
    return hits.slice(0, MAX_RESULTS);
  }

  const hits = [];
  const seen = new Set();
  for (const [name, [symbol, display]] of Object.entries(STOCK_NAMES)) {
    if ((name.includes(q) || symbol.toLowerCase().startsWith(q)) && !seen.has(symbol)) {
      seen.add(symbol);
      hits.push({ symbol, name: display, exchange: "", type: "" });
    }
  }
  return hits.slice(0, MAX_RESULTS);
}

// ── Full async search with per-query result cache ────────────────────────────

const resultCache = new Map(); // `${market}:${q}` → results
const CACHE_MAX = 200;

function cachePut(key, value) {
  if (resultCache.size >= CACHE_MAX) {
    resultCache.delete(resultCache.keys().next().value); // drop oldest
  }
  resultCache.set(key, value);
}

async function searchStocks(query) {
  const url = `${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0&enableFuzzyQuery=true`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  const quotes = Array.isArray(json?.quotes) ? json.quotes : [];
  return quotes
    .filter((q) => q?.symbol && STOCK_TYPES.has(String(q.quoteType || "").toUpperCase()))
    .map((q) => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      exchange: q.exchDisp || q.exchange || "",
      type: q.quoteTypeDisp || q.quoteType || "",
    }));
}

let cryptoListPromise = null;

async function loadCryptoList() {
  if (!cryptoListPromise) {
    cryptoListPromise = (async () => {
      const res = await fetch(BINANCE_EXCHANGE_INFO);
      if (!res.ok) throw new Error(`Binance error ${res.status}`);
      const json = await res.json();
      const list = (json?.symbols || [])
        .filter((s) => s.quoteAsset === "USDT" && s.status === "TRADING")
        .map((s) => ({ symbol: s.symbol, base: s.baseAsset }));
      cryptoListCache = list; // make available to localMatches
      return list;
    })().catch((err) => {
      cryptoListPromise = null; // allow retry
      throw err;
    });
  }
  return cryptoListPromise;
}

// Kick off the Binance list load early so the first crypto keystroke
// already has it — callers may invoke this on mount.
export function warmup(market) {
  if (market === "crypto") loadCryptoList().catch(() => {});
}

async function searchCrypto(query) {
  const q = query.trim().toLowerCase().replace(/[\s-]/g, "");
  if (!q) return [];
  const list = await loadCryptoList();

  const nameHits = new Set(
    Object.entries(CRYPTO_NAMES)
      .filter(([name]) => name.includes(q))
      .map(([, base]) => base)
  );

  const results = [];
  for (const { symbol, base } of list) {
    const b = base.toLowerCase();
    if (b.startsWith(q) || b.includes(q) || nameHits.has(base)) {
      results.push({
        symbol,
        name: CRYPTO_DISPLAY[base] || base,
        exchange: "Binance",
        type: "Crypto",
        _rank: b === q || nameHits.has(base) ? 0 : b.startsWith(q) ? 1 : 2,
      });
    }
  }
  results.sort(
    (a, b) => a._rank - b._rank || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol)
  );
  return results.map(({ _rank, ...r }) => r);
}

// → Promise<[{ symbol, name, exchange, type }]>; never throws. Local hits
// lead the list, remote results fill the rest (deduped by symbol).
export async function searchSymbols(query, market) {
  const q = (query || "").trim();
  if (!q) return [];
  const key = `${market}:${q.toLowerCase()}`;
  if (resultCache.has(key)) return resultCache.get(key);

  const local = localMatches(q, market);
  let remote = [];
  try {
    remote = market === "crypto" ? await searchCrypto(q) : await searchStocks(q);
  } catch {
    remote = [];
  }

  const seen = new Set(local.map((r) => r.symbol));
  const merged = [...local, ...remote.filter((r) => !seen.has(r.symbol))].slice(0, MAX_RESULTS);
  cachePut(key, merged);
  return merged;
}
