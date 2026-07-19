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

const YAHOO_INTERVAL = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "1d": "1d", "1w": "1wk", "1M": "1mo" };

/** Load one market from the universe. Returns null when the provider has no data. */
export async function loadMarket(m) {
  try {
    const candles = m.asset === "crypto"
      ? await fetchCrypto(m.symbol, m.interval, m.bars || 6000)
      : await fetchStock(m.symbol, m.range || "5y", YAHOO_INTERVAL[m.interval] || "1d");
    // Below this there is not enough history for a k-fold to mean anything.
    if (!candles || candles.length < 400) {
      console.error(`  ${m.id}: only ${candles?.length ?? 0} bars — skipped`);
      return null;
    }
    return { name: m.id, market: m, candles };
  } catch (e) {
    console.error(`  ${m.id}: ${e.message.slice(0, 70)}`);
    return null;
  }
}

/**
 * Load the whole test universe (or a subset). Sequential on purpose — Yahoo
 * rate-limits parallel bursts from one IP and starts returning empty results,
 * which would look like "strategy has no data" rather than "we were throttled".
 *
 * @param {Array} markets  entries from src/lib/markets.js UNIVERSE
 */
export async function loadUniverse(markets) {
  const out = [];
  for (const m of markets) {
    const ds = await loadMarket(m);
    if (ds) out.push(ds);
  }
  console.log(`markets: ${out.length}/${markets.length} loaded (${out.map((d) => `${d.name} ${d.candles.length}`).join(", ")})`);
  return out;
}
