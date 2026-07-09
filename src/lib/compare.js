// Vergleichs-Datenlayer: Monats-Serien, Dividenden und die reine Mathematik
// für Performance-Vergleich, Sparplan-Simulation (DCA) und Dividenden-Analyse.
//
// Kerzen-/Serienzeiten sind unix SECONDS, aufsteigend sortiert — gleiches
// Format wie src/lib/data.js. Krypto kommt direkt von Binance (CORS offen),
// Aktien laufen über den /api/yahoo-Proxy (Cloudflare Function bzw. Vite-Proxy).

const BINANCE = "https://api.binance.com/api/v3";
const YAHOO = "/api/yahoo/v8/finance/chart";

const YEAR_SECONDS = 365.25 * 86400;

// ── Fetcher ──────────────────────────────────────────────────────────────────

// Monatliche Schlusskurse, komplette Historie. → [{ time, close }]
export async function fetchMonthlySeries(market, symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("No symbol provided.");
  const series = market === "crypto" ? await fetchBinanceMonthly(sym) : await fetchYahooMonthly(sym);
  if (series.length < 2) throw new Error(`Too few data points for "${sym}".`);
  return series;
}

async function fetchBinanceMonthly(symbol) {
  // 1000 Monats-Klines ≈ 83 Jahre — deckt jede Krypto-Historie ab.
  const url = `${BINANCE}/klines?symbol=${encodeURIComponent(symbol)}&interval=1M&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 400) throw new Error(`Symbol "${symbol}" bei Binance nicht gefunden (z. B. BTCUSDT).`);
    throw new Error(`Binance-Fehler ${res.status}`);
  }
  const rows = await res.json();
  return rows.map((r) => ({ time: Math.floor(r[0] / 1000), close: +r[4] }));
}

async function fetchYahooMonthly(symbol) {
  const url = `${YAHOO}/${encodeURIComponent(symbol)}?range=max&interval=1mo`;
  const result = await fetchYahooChart(url, symbol);
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const series = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] == null) continue; // Lücken/Feiertage
    series.push({ time: ts[i], close: closes[i] });
  }
  return series;
}

// Dividenden-Historie (nur Aktien/ETFs). → [{ time, amount }], aufsteigend.
export async function fetchDividends(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) throw new Error("Kein Symbol angegeben.");
  const url = `${YAHOO}/${encodeURIComponent(sym)}?range=max&interval=1mo&events=div`;
  const result = await fetchYahooChart(url, sym);
  const raw = result.events?.dividends || {};
  return Object.values(raw)
    .filter((d) => d && d.amount != null)
    .map((d) => ({ time: d.date ?? 0, amount: +d.amount }))
    .filter((d) => d.time > 0 && Number.isFinite(d.amount))
    .sort((a, b) => a.time - b.time);
}

async function fetchYahooChart(url, symbol) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Datenabruf fehlgeschlagen (${res.status}) — Symbol korrekt? (z. B. AAPL, SPY, KO)`);
  }
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    throw new Error(json?.chart?.error?.description || `Keine Daten für "${symbol}".`);
  }
  return result;
}

// ── Pure Helpers ─────────────────────────────────────────────────────────────

// Serie auf Basis 100 normalisieren (Performance-Vergleich).
// [{ time, close }] → [{ time, value }]
export function rebase(series, base = 100) {
  if (!series?.length) return [];
  const first = series[0].close;
  if (!first) return [];
  return series.map((p) => ({ time: p.time, value: (p.close / first) * base }));
}

// Sparplan-Simulation: jeden Monat für `monthlyAmount` zum Monatsschluss
// kaufen (Bruchstücke erlaubt).
export function simulateDCA(series, monthlyAmount) {
  const amount = +monthlyAmount || 0;
  if (!series?.length || amount <= 0) {
    return { points: [], totalInvested: 0, finalValue: 0, totalReturnPct: 0, cagrPct: 0, shares: 0 };
  }
  let shares = 0;
  let invested = 0;
  const points = [];
  for (const p of series) {
    if (!p.close) continue;
    shares += amount / p.close;
    invested += amount;
    points.push({ time: p.time, invested, value: shares * p.close });
  }
  const last = points[points.length - 1];
  const totalInvested = invested;
  const finalValue = last ? last.value : 0;
  const totalReturnPct = totalInvested > 0 ? (finalValue / totalInvested - 1) * 100 : 0;
  const years = points.length > 1 ? (points[points.length - 1].time - points[0].time) / YEAR_SECONDS : 0;
  // Näherung: Multiple auf die Gesamteinzahlung annualisiert (Geldeingang
  // verteilt sich über die Laufzeit, exakte IRR wäre iterativ).
  const cagrPct =
    years > 0 && totalInvested > 0 ? (Math.pow(finalValue / totalInvested, 1 / years) - 1) * 100 : 0;
  return { points, totalInvested, finalValue, totalReturnPct, cagrPct, shares };
}

// Dividenden an die Kurs-Serie ausrichten und Kennzahlen über ein Fenster
// (windowYears, null/undefined = komplette Historie) berechnen.
export function dividendStats(series, dividends, windowYears) {
  const empty = { totalPerShare: 0, yearlySums: [], avgYieldPct: null, growthPct: null };
  if (!series?.length || !dividends?.length) return empty;

  const firstTime = series[0].time;
  const lastTime = series[series.length - 1].time;
  const cutoff = windowYears ? Math.max(firstTime, lastTime - windowYears * YEAR_SECONDS) : firstTime;

  const divs = dividends.filter((d) => d.time >= cutoff && d.time <= lastTime);
  if (!divs.length) return empty;

  // Jahressummen
  const byYear = new Map();
  let totalPerShare = 0;
  for (const d of divs) {
    const year = new Date(d.time * 1000).getUTCFullYear();
    byYear.set(year, (byYear.get(year) || 0) + d.amount);
    totalPerShare += d.amount;
  }
  const yearlySums = [...byYear.entries()]
    .map(([year, sum]) => ({ year, sum }))
    .sort((a, b) => a.year - b.year);

  // Ø Rendite: Jahressumme geteilt durch letzten Kurs des Jahres, gemittelt.
  const yields = [];
  for (const { year, sum } of yearlySums) {
    const yearEnd = Date.UTC(year, 11, 31, 23, 59, 59) / 1000;
    let price = null;
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].time > yearEnd) continue;
      if (new Date(series[i].time * 1000).getUTCFullYear() === year) price = series[i].close;
      break;
    }
    if (price) yields.push((sum / price) * 100);
  }
  const avgYieldPct = yields.length ? yields.reduce((a, b) => a + b, 0) / yields.length : null;

  // Wachstum p.a.: CAGR der Jahressummen, unvollständige Randjahre ignorieren
  // (das Jahr des Fensterbeginns und das laufende letzte Datenjahr).
  const startYear = new Date(cutoff * 1000).getUTCFullYear();
  const endYear = new Date(lastTime * 1000).getUTCFullYear();
  const complete = yearlySums.filter((y) => y.year > startYear && y.year < endYear);
  let growthPct = null;
  if (complete.length >= 2) {
    const first = complete[0];
    const last = complete[complete.length - 1];
    const span = last.year - first.year;
    if (first.sum > 0 && span > 0) {
      growthPct = (Math.pow(last.sum / first.sum, 1 / span) - 1) * 100;
    }
  }

  return { totalPerShare, yearlySums, avgYieldPct, growthPct };
}
