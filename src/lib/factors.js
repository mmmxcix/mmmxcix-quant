// factors.js — cross-sectional anomaly engine for the Anomalies page.
//
// Three documented return anomalies, computed on live data over a curated
// liquid US large-cap universe (small by academic standards — this is an
// educational demonstration of the mechanics, not an investable product):
//
//   1. Betting Against Beta (Frazzini & Pedersen 2014) — rank by rolling
//      beta, long the low-beta bucket levered up to beta≈1, short the
//      high-beta bucket delevered to beta≈1, rebalance monthly.
//   2. Accruals (Sloan 1996) — (net income − operating cash flow) / total
//      assets; low accruals = cash-backed earnings (historically strong),
//      high accruals = paper earnings (historically weak).
//   3. Short interest — short % of float and days-to-cover; heavily shorted
//      names have historically underperformed.
//
// Price data via /api/yahoo v8 chart; fundamentals via the ws/ timeseries
// endpoint; short interest via v10 quoteSummary (crumb handled by the proxy).

const YAHOO_CHART = "/api/yahoo/v8/finance/chart";
const YAHOO_SUMMARY = "/api/yahoo/v10/finance/quoteSummary";
const YAHOO_TIMESERIES = "/api/yahoo/ws/fundamentals-timeseries/v1/finance/timeseries";

export const BENCHMARK = "SPY";

// Single names only (no ETFs — factor sorts need stocks). Mirrors the
// screener's liquid universe.
export const FACTOR_UNIVERSE = [
  ["AAPL", "Apple"], ["MSFT", "Microsoft"], ["NVDA", "NVIDIA"], ["GOOGL", "Alphabet"],
  ["AMZN", "Amazon"], ["META", "Meta"], ["TSLA", "Tesla"], ["AVGO", "Broadcom"],
  ["JPM", "JPMorgan"], ["V", "Visa"], ["MA", "Mastercard"], ["LLY", "Eli Lilly"],
  ["UNH", "UnitedHealth"], ["XOM", "Exxon Mobil"], ["JNJ", "Johnson & Johnson"],
  ["WMT", "Walmart"], ["PG", "Procter & Gamble"], ["HD", "Home Depot"], ["KO", "Coca-Cola"],
  ["PEP", "PepsiCo"], ["COST", "Costco"], ["MCD", "McDonald's"], ["NFLX", "Netflix"],
  ["AMD", "AMD"], ["INTC", "Intel"], ["CSCO", "Cisco"], ["ORCL", "Oracle"], ["CRM", "Salesforce"],
  ["ADBE", "Adobe"], ["PYPL", "PayPal"], ["DIS", "Disney"], ["BA", "Boeing"], ["NKE", "Nike"],
  ["PLTR", "Palantir"], ["UBER", "Uber"], ["BAC", "Bank of America"], ["PFE", "Pfizer"],
  ["T", "AT&T"], ["VZ", "Verizon"], ["CVX", "Chevron"],
];

const CACHE_TTL = 15 * 60 * 1000;
const cache = new Map(); // key → { t, data }

function cacheGet(key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.t < CACHE_TTL ? hit.data : null;
}
function cacheSet(key, data) {
  cache.set(key, { t: Date.now(), data });
  return data;
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Price series ─────────────────────────────────────────────────────────────

/** Daily closes for one symbol: { symbol, days: Map(dayKey → close) }. */
export async function fetchDailySeries(symbol, range = "2y") {
  const res = await fetch(`${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=${range}&interval=1d`);
  if (!res.ok) throw new Error(`chart ${symbol} → ${res.status}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const cl = r?.indicators?.quote?.[0]?.close || [];
  const days = new Map();
  for (let i = 0; i < ts.length; i++) {
    if (cl[i] != null && cl[i] > 0) days.set(Math.floor(ts[i] / 86400), cl[i]);
  }
  if (!days.size) throw new Error(`no data for ${symbol}`);
  return { symbol, days };
}

/**
 * Fetch + align a symbol list onto shared trading days. Symbols covering
 * <90% of the benchmark's days are dropped (recent IPOs etc.), then the
 * remaining series are intersected. Returns:
 * { times: number[] (unix sec, ascending), closes: { [symbol]: number[] }, dropped: string[] }
 */
export async function fetchAligned(symbols, range = "2y", onProgress) {
  let done = 0;
  const series = await mapLimit(symbols, 6, async (sym) => {
    try {
      return await fetchDailySeries(sym, range);
    } catch {
      return null; // skip failures; they land in `dropped`
    } finally {
      onProgress?.(++done, symbols.length);
    }
  });

  const ok = series.filter(Boolean);
  if (!ok.length) throw new Error("No price data loaded — is the market data proxy reachable?");
  // Coverage is measured against the MEDIAN day count, not the max: a 7-day
  // asset like BTC-USD would otherwise make every 5-day equity look sparse.
  const sizes = ok.map((s) => s.days.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  const kept = ok.filter((s) => s.days.size >= median * 0.9);
  const dropped = symbols.filter((sym) => !kept.some((s) => s.symbol === sym));

  // Intersect day keys across all kept series.
  const counts = new Map();
  for (const s of kept) for (const d of s.days.keys()) counts.set(d, (counts.get(d) || 0) + 1);
  const shared = [...counts.entries()].filter(([, c]) => c === kept.length).map(([d]) => d).sort((a, b) => a - b);

  const closes = {};
  for (const s of kept) closes[s.symbol] = shared.map((d) => s.days.get(d));
  return { times: shared.map((d) => d * 86400), closes, dropped };
}

/** Simple returns r[i] = c[i+1]/c[i] − 1 (length n−1). */
export function dailyReturns(closes) {
  const out = new Array(closes.length - 1);
  for (let i = 1; i < closes.length; i++) out[i - 1] = closes[i] / closes[i - 1] - 1;
  return out;
}

/** OLS beta of `asset` vs `market` over returns[lo..hi) (index bounds). */
function betaOver(asset, market, lo, hi) {
  let n = 0, sx = 0, sy = 0;
  for (let i = lo; i < hi; i++) { sx += market[i]; sy += asset[i]; n++; }
  if (n < 2) return null;
  const mx = sx / n, my = sy / n;
  let cov = 0, varm = 0;
  for (let i = lo; i < hi; i++) {
    cov += (market[i] - mx) * (asset[i] - my);
    varm += (market[i] - mx) * (market[i] - mx);
  }
  return varm > 0 ? cov / varm : null;
}

function curveStats(returns, periodsPerYear = 252) {
  const n = returns.length;
  if (!n) return { annRetPct: 0, annVolPct: 0, sharpe: 0, maxDDPct: 0 };
  let eq = 1, peak = 1, maxDD = 0, sum = 0, sum2 = 0;
  for (const r of returns) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
    sum += r; sum2 += r * r;
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const annRet = Math.pow(eq, periodsPerYear / n) - 1;
  const annVol = sd * Math.sqrt(periodsPerYear);
  return {
    annRetPct: annRet * 100,
    annVolPct: annVol * 100,
    sharpe: annVol > 0 ? (mean * periodsPerYear) / annVol : 0,
    maxDDPct: maxDD * 100,
  };
}

// ── 1. Betting Against Beta ──────────────────────────────────────────────────

/**
 * Run the BAB mini-backtest on live prices.
 *
 * @returns {{
 *   curves: { bab, market, lowLeg, highLeg }  // [{x: unix sec, y: index (start=100)}]
 *   stats:  { bab, market }                   // curveStats each
 *   snapshot: [{ symbol, name, beta, bucket }] // latest betas, sorted ascending
 *   scatter: [{ symbol, beta, annRetPct }]     // full-sample SML flatness
 *   meta: { nSymbols, from, to, wLong, wShort, dropped }
 * }}
 */
export async function runBAB({ range = "5y", window = 252, rebalance = 21, bucketPct = 0.2, onProgress } = {}) {
  const key = `bab:${range}:${window}:${rebalance}:${bucketPct}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const symbols = FACTOR_UNIVERSE.map(([s]) => s);
  const { times, closes, dropped } = await fetchAligned([BENCHMARK, ...symbols], range, onProgress);
  if (!closes[BENCHMARK]) throw new Error("Benchmark data missing.");

  const names = symbols.filter((s) => closes[s]);
  const rets = Object.fromEntries([BENCHMARK, ...names].map((s) => [s, dailyReturns(closes[s])]));
  const market = rets[BENCHMARK];
  const nT = market.length; // return index i covers times[i] → times[i+1]

  if (nT <= window + rebalance) throw new Error("Not enough history for the beta window — use a longer range.");

  const babR = [], mktR = [], lowR = [], highR = [];
  const outTimes = [];
  let lastWeights = { wLong: 1, wShort: 1 };
  let latestRanks = [];

  for (let t = window; t < nT; t += rebalance) {
    // Rank by trailing beta over [t−window, t).
    const ranked = [];
    for (const s of names) {
      const b = betaOver(rets[s], market, t - window, t);
      if (b !== null) ranked.push({ symbol: s, beta: b });
    }
    if (ranked.length < 10) continue;
    ranked.sort((a, b) => a.beta - b.beta);
    const k = Math.max(3, Math.round(ranked.length * bucketPct));
    const low = ranked.slice(0, k);
    const high = ranked.slice(-k);
    const betaL = low.reduce((a, x) => a + x.beta, 0) / k;
    const betaH = high.reduce((a, x) => a + x.beta, 0) / k;
    // Scale both legs to beta ≈ 1 (the paper's self-financing construction),
    // with sane clamps so a near-zero leg beta can't explode leverage.
    const wLong = Math.min(3, 1 / Math.max(betaL, 0.33));
    const wShort = Math.min(3, 1 / Math.max(betaH, 0.33));
    lastWeights = { wLong, wShort };
    latestRanks = ranked;

    const end = Math.min(t + rebalance, nT);
    for (let i = t; i < end; i++) {
      let rl = 0, rh = 0;
      for (const x of low) rl += rets[x.symbol][i];
      for (const x of high) rh += rets[x.symbol][i];
      rl /= k; rh /= k;
      babR.push(wLong * rl - wShort * rh);
      lowR.push(rl);
      highR.push(rh);
      mktR.push(market[i]);
      outTimes.push(times[i + 1]);
    }
  }

  const toCurve = (rs) => {
    let v = 100;
    return rs.map((r, i) => ({ x: outTimes[i], y: (v *= 1 + r) }));
  };

  // Full-sample beta vs realized return per name — the "flat security market
  // line" scatter that motivates the whole strategy.
  const yearsCovered = (times[times.length - 1] - times[0]) / (365.25 * 86400);
  const scatter = names.map((s) => {
    const b = betaOver(rets[s], market, 0, nT);
    const total = closes[s][closes[s].length - 1] / closes[s][0];
    return { symbol: s, beta: b, annRetPct: (Math.pow(total, 1 / Math.max(yearsCovered, 0.5)) - 1) * 100 };
  }).filter((p) => p.beta !== null);

  const k = Math.max(3, Math.round(latestRanks.length * bucketPct));
  const nameOf = Object.fromEntries(FACTOR_UNIVERSE);
  const snapshot = latestRanks.map((r, i) => ({
    symbol: r.symbol,
    name: nameOf[r.symbol] || r.symbol,
    beta: r.beta,
    bucket: i < k ? "low" : i >= latestRanks.length - k ? "high" : "mid",
  }));

  return cacheSet(key, {
    curves: { bab: toCurve(babR), market: toCurve(mktR), lowLeg: toCurve(lowR), highLeg: toCurve(highR) },
    stats: { bab: curveStats(babR), market: curveStats(mktR) },
    snapshot,
    scatter,
    meta: {
      nSymbols: names.length,
      from: outTimes[0],
      to: outTimes[outTimes.length - 1],
      wLong: lastWeights.wLong,
      wShort: lastWeights.wShort,
      dropped,
    },
  });
}

// ── 2. Accruals (Sloan 1996) ─────────────────────────────────────────────────

const TS_TYPES = [
  "annualNetIncome",
  "annualNetIncomeCommonStockholders",
  "annualOperatingCashFlow",
  "annualCashFlowFromContinuingOperatingActivities",
  "annualTotalAssets",
];

/** Annual fundamentals for one symbol: { [type]: [{date, value}] } (ascending). */
async function fetchFundamentals(symbol) {
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - 5 * 365 * 86400;
  const url = `${YAHOO_TIMESERIES}/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}` +
    `&type=${TS_TYPES.join(",")}&period1=${p1}&period2=${p2}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fundamentals ${symbol} → ${res.status}`);
  const json = await res.json();
  const out = {};
  for (const r of json?.timeseries?.result || []) {
    const type = r?.meta?.type?.[0];
    if (!type || !Array.isArray(r[type])) continue;
    out[type] = r[type]
      .filter((v) => v && v.reportedValue?.raw != null)
      .map((v) => ({ date: v.asOfDate, value: v.reportedValue.raw }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return out;
}

const last = (arr) => (arr?.length ? arr[arr.length - 1] : null);

/**
 * Sloan's cash-flow-statement accruals: (NI − CFO) / avg total assets, from
 * the latest fiscal year. Negative = earnings are MORE than cash-backed
 * (historically the strong bucket); large positive = paper earnings.
 */
function accrualRow(f) {
  const ni = last(f.annualNetIncome) ?? last(f.annualNetIncomeCommonStockholders);
  const cfo = last(f.annualOperatingCashFlow) ?? last(f.annualCashFlowFromContinuingOperatingActivities);
  const ta = f.annualTotalAssets;
  if (!ni || !cfo || !ta?.length) return null;
  const assets = ta.length >= 2 ? (ta[ta.length - 1].value + ta[ta.length - 2].value) / 2 : ta[ta.length - 1].value;
  if (!(assets > 0)) return null;
  return {
    accrualsPct: ((ni.value - cfo.value) / assets) * 100,
    netIncome: ni.value,
    cfo: cfo.value,
    assets,
    fiscalYear: (ni.date || "").slice(0, 4),
  };
}

/** Scan the universe; rows sorted ascending (low accruals first), quintiled. */
export async function scanAccruals({ universe = FACTOR_UNIVERSE, onProgress } = {}) {
  const hit = cacheGet("accruals");
  if (hit) return hit;
  let done = 0;
  const rows = await mapLimit(universe, 6, async ([symbol, name]) => {
    try {
      const row = accrualRow(await fetchFundamentals(symbol));
      return row ? { symbol, name, ...row } : { symbol, name, accrualsPct: null };
    } catch {
      return { symbol, name, accrualsPct: null };
    } finally {
      onProgress?.(++done, universe.length);
    }
  });
  const ok = rows.filter((r) => r.accrualsPct !== null).sort((a, b) => a.accrualsPct - b.accrualsPct);
  const missing = rows.filter((r) => r.accrualsPct === null);
  ok.forEach((r, i) => { r.quintile = Math.min(5, 1 + Math.floor((i / ok.length) * 5)); });
  return cacheSet("accruals", { rows: ok, missing: missing.map((r) => r.symbol) });
}

// ── 3. Short interest ────────────────────────────────────────────────────────

const raw = (v) => (v && typeof v === "object" ? v.raw ?? null : typeof v === "number" ? v : null);

async function fetchShortStats(symbol) {
  const url = `${YAHOO_SUMMARY}/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`quoteSummary ${symbol} → ${res.status}`);
  const json = await res.json();
  const ks = json?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
  if (!ks) return null;
  const sharesShort = raw(ks.sharesShort);
  const prior = raw(ks.sharesShortPriorMonth);
  return {
    shortPctFloat: raw(ks.shortPercentOfFloat) != null ? raw(ks.shortPercentOfFloat) * 100 : null,
    daysToCover: raw(ks.shortRatio),
    sharesShort,
    momChangePct: sharesShort && prior ? (sharesShort / prior - 1) * 100 : null,
  };
}

/** Scan the universe; rows sorted descending by short % of float, quintiled. */
export async function scanShortInterest({ universe = FACTOR_UNIVERSE, onProgress } = {}) {
  const hit = cacheGet("short");
  if (hit) return hit;
  let done = 0;
  const rows = await mapLimit(universe, 6, async ([symbol, name]) => {
    try {
      const s = await fetchShortStats(symbol);
      return { symbol, name, ...(s || { shortPctFloat: null }) };
    } catch {
      return { symbol, name, shortPctFloat: null };
    } finally {
      onProgress?.(++done, universe.length);
    }
  });
  const ok = rows.filter((r) => r.shortPctFloat !== null).sort((a, b) => b.shortPctFloat - a.shortPctFloat);
  const missing = rows.filter((r) => r.shortPctFloat === null);
  ok.forEach((r, i) => { r.quintile = Math.min(5, 1 + Math.floor((i / ok.length) * 5)); });
  return cacheSet("short", { rows: ok, missing: missing.map((r) => r.symbol) });
}
