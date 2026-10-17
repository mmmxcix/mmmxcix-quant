// portfolioTotals.js — rows + totals for the Portfolio page, pure.
//
// The rule this file exists for: a position without a CURRENT quote is not
// worth $0. The page used to sum `value ?? 0` while summing every position's
// cost, so one failed quote printed a fake loss the size of that position.
// Now a position priced from a stale quote (or with no quote at all) keeps its
// row, its last known price and that price's age, but is left out of every
// total that claims to be current — value, invested, P/L, today's P/L and
// allocation — and the totals say how many positions they leave out.

/**
 * @param positions  portfolio entries ({ market, symbol, shares, avgPrice, sellPrice?, ... })
 * @param quotes     { "market:symbol": { price, changePct, stale?, asOf? } }
 * @param isClosed   (position) => boolean
 */
export function computeHoldings(positions, quotes, isClosed) {
  const computed = positions.map((p) => {
    const closed = isClosed(p);
    const cost = p.shares * p.avgPrice;
    if (closed) {
      // Realized: frozen at the sale — no live quote involved.
      const value = p.shares * p.sellPrice;
      const pnl = value - cost;
      return {
        ...p, closed: true, price: p.sellPrice, changePct: null, cost, value, pnl,
        pnlPct: cost > 0 ? (pnl / cost) * 100 : null, prevClose: null, dayPnl: null,
        stale: false, asOf: null, live: false,
      };
    }
    const q = quotes[`${p.market}:${p.symbol}`];
    const price = q && Number.isFinite(q.price) ? q.price : null;
    const changePct = q && Number.isFinite(q.changePct) ? q.changePct : null;
    // Live = priced by a quote that did not fail this poll. A stale price is
    // still shown (with its age), it just doesn't feed the totals.
    const stale = price == null || !!q?.stale;
    const asOf = q?.asOf ?? null;
    const value = price != null ? p.shares * price : null;
    const pnl = value != null ? value - cost : null;
    const pnlPct = value != null && cost > 0 ? (pnl / cost) * 100 : null;
    // Today's move: back out yesterday's close from the live day-change %, so
    // the day P/L tracks the market in real time (updates every poll).
    const prevClose = price != null && changePct != null ? price / (1 + changePct / 100) : null;
    const dayPnl = prevClose != null ? p.shares * (price - prevClose) : null;
    return { ...p, closed: false, price, changePct, cost, value, pnl, pnlPct, prevClose, dayPnl, stale, asOf, live: !stale };
  });
  const open = computed.filter((r) => !r.closed);
  const live = open.filter((r) => r.live);
  const excluded = open.filter((r) => !r.live);
  const closedRows = computed.filter((r) => r.closed);

  const totalValue = live.reduce((s, r) => s + r.value, 0);
  const totalCost = live.reduce((s, r) => s + (r.cost || 0), 0);
  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : null;
  // Realized P/L across all closed positions.
  const realizedPnl = closedRows.reduce((s, r) => s + r.pnl, 0);
  const realizedCost = closedRows.reduce((s, r) => s + r.cost, 0);
  const realizedPct = realizedCost > 0 ? (realizedPnl / realizedCost) * 100 : null;
  // Today's P/L across the live OPEN book, and yesterday's value as its % base.
  const dayPnl = live.reduce((s, r) => s + (r.dayPnl ?? 0), 0);
  const dayBase = live.reduce((s, r) => s + (r.prevClose != null ? r.shares * r.prevClose : 0), 0);
  const dayPnlPct = dayBase > 0 ? (dayPnl / dayBase) * 100 : null;
  const dayHasData = live.some((r) => r.dayPnl != null);
  // Allocation is % of current live value; closed rows sink below open ones.
  const withAlloc = [...open, ...closedRows].map((r) => ({
    ...r,
    allocPct: r.live && totalValue > 0 ? (r.value / totalValue) * 100 : null,
  }));
  return {
    rows: withAlloc,
    totals: {
      totalValue, totalCost, totalPnl, totalPnlPct, dayPnl, dayPnlPct, dayHasData,
      realizedPnl, realizedPct, hasClosed: closedRows.length > 0, count: computed.length,
      // What the current totals leave out, so the page can say so.
      excludedCount: excluded.length,
      excludedSymbols: excluded.map((r) => r.symbol),
      // Last-known value of the left-out positions, shown separately and
      // labelled — never folded into a total that reads as current.
      excludedStaleValue: excluded.reduce((s, r) => s + (r.value ?? 0), 0),
    },
  };
}

/** "3 min ago" style age for a stale price; null when unknown. */
export function ageLabel(asOf, now = Date.now()) {
  if (!Number.isFinite(asOf)) return null;
  const s = Math.max(0, Math.round((now - asOf) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
