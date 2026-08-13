// chartLink.js — build a /charts URL that draws an agent's trade on the real
// price chart: entry / stop / target as price lines, a marker at the entry, and
// the reason the agent gave.
//
// Shared by Argus and by Kronos (the Arena page) so both agents' trades are
// inspected the same way. It lives here rather than in either page because the
// two disagree on one detail that is invisible until it is wrong: Argus stores
// timestamps in MILLISECONDS and Kronos, being Python, stores them in SECONDS.
// A marker placed 1000× too late lands somewhere in the year 57000 and simply
// does not render — no error, just an empty chart. So the unit is in the
// parameter name and converted in exactly one place.

const CRYPTO = /USDT$|USD$|BTC$|ETH$/;

const TF_TO_INTERVAL = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h", "1d": "1d",
};

/**
 * @param t {{symbol, asset?, timeframe?, entry?, stop?, target?, side?,
 *           atMs?, reason?, label?}}
 * @param outcome  open | planned | target | stop | signal | eod | horizon | …
 */
export function chartHref(t, outcome = "open") {
  const market = t.asset === "crypto" || (t.asset == null && CRYPTO.test(t.symbol || ""))
    ? "crypto" : "stock";
  const p = new URLSearchParams({
    market,
    symbol: t.symbol,
    interval: TF_TO_INTERVAL[t.timeframe] || "15m",
  });
  if (Number.isFinite(t.entry)) p.set("tEntry", String(t.entry));
  if (Number.isFinite(t.stop)) p.set("tStop", String(t.stop));
  if (Number.isFinite(t.target)) p.set("tTarget", String(t.target));
  if (t.side) p.set("tSide", t.side);
  if (Number.isFinite(t.atMs)) p.set("tAt", String(Math.round(t.atMs / 1000))); // charts want seconds
  if (t.reason) p.set("tReason", String(t.reason).slice(0, 180));
  if (t.label) p.set("tLabel", String(t.label).slice(0, 60));
  p.set("tOutcome", outcome);
  return `/charts?${p.toString()}`;
}

/**
 * A whole trade LOG on one chart — an arrow at every entry and every exit —
 * rather than one trade at a time. Same compact shape the Lab agent uses:
 * a = entry time, x = exit time (both unix SECONDS), s = side, e/p = prices.
 *
 * @param trades  [{ symbol, side, entry, exit, openedAtMs, closedAtMs }]
 */
export function chartLogHref(symbol, trades, { asset = "crypto", timeframe = "1h", name = "" } = {}) {
  const rows = (trades || [])
    .filter((t) => t.symbol === symbol && Number.isFinite(t.openedAtMs))
    .map((t) => ({
      a: Math.round(t.openedAtMs / 1000),
      x: Number.isFinite(t.closedAtMs) ? Math.round(t.closedAtMs / 1000) : undefined,
      s: t.side === "short" ? "short" : "long",
      e: t.entry,
      p: t.exit,
    }));
  if (!rows.length) return null;
  const p = new URLSearchParams({
    market: asset === "crypto" ? "crypto" : "stock",
    symbol,
    interval: TF_TO_INTERVAL[timeframe] || "1h",
    tTrades: JSON.stringify(rows),
  });
  if (name) p.set("tName", name);
  return `/charts?${p.toString()}`;
}
