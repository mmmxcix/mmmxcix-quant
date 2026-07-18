// marketdata.mjs — the candle fetchers the Node agents share.
//
// These existed as byte-identical copies in research-agent.mjs and (with a
// different interval map) lab-agent.mjs. Two copies is a coincidence; three is
// a drift bug waiting to happen, so the validation-side fetchers live here.
//
// Free, keyless sources: Binance for crypto, Yahoo's chart endpoint for equity.
// Both return the site's candle contract: { time (unix seconds), o/h/l/c/v },
// ascending, no gaps introduced.

export async function fetchCrypto(symbol, interval, bars) {
  let out = [], end = Date.now();
  while (out.length < bars) {
    const rows = await (await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${end}&limit=1000`
    )).json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out = [
      ...rows.map((r) => ({
        time: Math.floor(r[0] / 1000),
        open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
      })),
      ...out,
    ];
    end = rows[0][0] - 1;
    if (rows.length < 1000) break;
  }
  return out.slice(-bars);
}

export async function fetchStock(symbol, range = "10y", interval = "1d") {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
    { headers: { "user-agent": "Mozilla/5.0" } }
  );
  const r = (await res.json())?.chart?.result?.[0];
  if (!r) throw new Error(`no data for ${symbol}`);
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return out;
}

/**
 * The standard two-market validation set. Deliberately one 24/7 crypto series
 * and one equity index: a rule that only works on one of them is usually
 * fitting a market's quirks rather than a real effect.
 */
export async function validationDatasets() {
  return [
    { name: "BTC4h", candles: await fetchCrypto("BTCUSDT", "4h", 6000) },
    { name: "SPY1d", candles: await fetchStock("SPY") },
  ];
}
