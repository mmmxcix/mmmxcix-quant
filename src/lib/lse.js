// lse.js — client for the London Strategic Edge data archive, reached through
// our server proxy (/api/lse/*, key attached server-side; see
// functions/api/lse/[[path]].js). 133B ticks / 118k datasets — used as an
// alternative candle source for stock backtests and (later) bonds/macro.

const PROXY = "/api/lse";

// Site interval id → LSE timeframe. Only what the archive actually serves.
const TF = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "1d": "1d", "1w": "1w" };

const iso = (d) => d.toISOString().slice(0, 10);

/** True once the proxy has a key configured (cached for the session). */
let availability = null;
export async function lseAvailable() {
  if (availability !== null) return availability;
  try {
    const res = await fetch(`${PROXY}/health`, { signal: AbortSignal.timeout(6000) });
    availability = res.ok;
  } catch {
    availability = false;
  }
  return availability;
}

/**
 * Fetch candles from the LSE archive, normalized to the site's candle shape
 * ({ time: unixSec, open, high, low, close, volume }, ascending).
 * @param {{ symbol: string, interval: string, rangeDays: number }} opts
 */
export async function fetchLseCandles({ symbol, interval = "1d", rangeDays = 365 }) {
  const tf = TF[interval];
  if (!tf) throw new Error(`London archive doesn't serve the ${interval} interval.`);
  // LSE wants FX as "EUR/USD" — translate the Yahoo-style "EURUSD=X" the rest
  // of the site uses. (Crypto stays on Binance: LSE's BTC/USD is a different
  // quote currency than our USDT pairs — swapping them would falsify data.)
  const up = symbol.toUpperCase();
  const fx = /^([A-Z]{3})([A-Z]{3})=X$/.exec(up);
  const lseSymbol = fx ? `${fx[1]}/${fx[2]}` : up;
  const end = new Date();
  const start = new Date(end.getTime() - rangeDays * 86400_000);
  const url = `${PROXY}/v1/candles?symbol=${encodeURIComponent(lseSymbol)}&timeframe=${tf}&start=${iso(start)}&end=${iso(end)}`;
  const res = await fetch(url);
  if (res.status === 503) throw new Error("London data not configured — set the LSE_API_KEY secret.");
  if (!res.ok) throw new Error(`London data request failed (${res.status}) — is the symbol in the archive?`);
  const json = await res.json();
  // Row shape (validated): { timestamp: ISO, open, high, low, close, volume }.
  // The rows may arrive as a plain array or wrapped ({data|candles|results}).
  const rows = Array.isArray(json) ? json : json?.data || json?.candles || json?.results || [];
  const out = [];
  for (const r of rows) {
    const t = Date.parse(r.timestamp ?? r.time ?? r.date);
    if (!Number.isFinite(t) || r.open == null || r.close == null) continue;
    out.push({
      time: Math.floor(t / 1000),
      open: +r.open, high: +(r.high ?? r.open), low: +(r.low ?? r.open), close: +r.close,
      volume: +(r.volume ?? 0),
    });
  }
  out.sort((a, b) => a.time - b.time);
  if (out.length < 2) throw new Error(`No usable London data for "${symbol}".`);
  return out;
}
