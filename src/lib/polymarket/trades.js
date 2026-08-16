// trades.js — an OrderFilled event, decoded into a trade a human can check.
//
// Polymarket's exchange emits one event per filled side:
//
//   OrderFilled(orderHash, maker, taker, makerAssetId, takerAssetId,
//               makerAmountFilled, takerAmountFilled, fee)
//
// Asset id "0" is USDC; anything else is a conditional-token id — one outcome of
// one market. So the direction is read off which side is cash:
//
//   makerAssetId == 0  → the maker paid USDC and received tokens → maker BOUGHT
//   takerAssetId == 0  → the maker delivered tokens and received USDC → SOLD
//
// Both amounts are 6-decimal integers, and the price of a share is simply
// usdc/tokens. On a binary market that number is the implied probability, so it
// lives in (0,1) and a decode that ever leaves that range is a decode bug, not
// an interesting market — `decodeFill` refuses those rather than passing them on.
//
// A NOTE ON WHO IS WHO. The taker is very often the exchange contract itself
// (negative-risk conversions route through it), not a person. Those addresses
// are in CONTRACTS below and are never treated as wallets; counting them would
// produce a handful of "traders" with billions in volume and a perfect record.

/** Known Polymarket infrastructure — never a wallet, never copyable. */
export const CONTRACTS = new Set([
  "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e", // CTF Exchange
  "0xc5d563a36ae78145c45a50134d48a1215220f80a", // NegRisk CTF Exchange
  "0x4d97dcd97ec945f40cf65f87097ace5ea0476045", // Conditional Tokens
  "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296", // NegRisk Adapter
  "0x0000000000000000000000000000000000000000",
]);

const SIX = 1e6;

/**
 * Decode one raw subgraph fill into the maker's trade.
 *
 * @returns {null|{ts, wallet, counterparty, tokenId, side, usdc, tokens, price, fee, id}}
 *   `usdc` and `tokens` are always positive magnitudes; `side` carries the sign.
 *   Returns null for anything that is not a clean cash-for-tokens fill.
 */
export function decodeFill(f) {
  const mk = String(f.makerAssetId ?? "");
  const tk = String(f.takerAssetId ?? "");
  // Exactly one leg must be cash. Token-for-token is a merge/split, not a trade
  // at a price, and cash-for-cash is meaningless.
  const makerPaysCash = mk === "0";
  const makerGetsCash = tk === "0";
  if (makerPaysCash === makerGetsCash) return null;

  const a = Number(f.makerAmountFilled), b = Number(f.takerAmountFilled);
  if (!(a > 0) || !(b > 0)) return null;

  const usdc = (makerPaysCash ? a : b) / SIX;
  const tokens = (makerPaysCash ? b : a) / SIX;
  const price = usdc / tokens;
  // A share of a binary outcome cannot be worth less than nothing or more than a
  // dollar. Outside that, the row is not what we think it is.
  if (!(price > 0) || !(price < 1)) return null;

  const wallet = String(f.maker || "").toLowerCase();
  const counterparty = String(f.taker || "").toLowerCase();
  return {
    id: f.id,
    ts: Number(f.timestamp),
    wallet,
    counterparty,
    tokenId: makerPaysCash ? tk : mk,
    side: makerPaysCash ? "buy" : "sell",
    usdc, tokens, price,
    fee: Number(f.fee || 0) / SIX,
  };
}

/** Decode a wallet's raw fills, keeping only the ones where IT is the maker. */
export function walletTrades(address, fills) {
  const me = String(address).toLowerCase();
  const out = [];
  for (const f of fills || []) {
    const t = decodeFill(f);
    if (!t) continue;
    if (t.wallet !== me) continue;      // it was on the taker side; the price is the OTHER party's
    if (CONTRACTS.has(me)) continue;
    out.push(t);
  }
  return out.sort((x, y) => x.ts - y.ts);
}

/**
 * FIFO round trips, plus whatever is still open.
 *
 * Realised P&L only counts shares that were bought AND sold, which is the only
 * P&L that needs no resolution data — and it has a known bias that must travel
 * with it: a wallet that takes profits and sits on losers looks better than it
 * is. `openCost` is reported for exactly that reason, so the size of the
 * unmeasured half is always visible next to the measured one.
 *
 * @returns {{realized, closedCost, openCost, openTokens, trades, roundTrips}}
 */
export function fifoPnl(trades) {
  const lots = new Map();     // tokenId → [{tokens, price}]
  let realized = 0, closedCost = 0, roundTrips = 0;

  for (const t of trades) {
    if (t.side === "buy") {
      if (!lots.has(t.tokenId)) lots.set(t.tokenId, []);
      lots.get(t.tokenId).push({ tokens: t.tokens, price: t.price });
      continue;
    }
    // A sell with no matching inventory is a short: the wallet sold shares it
    // acquired elsewhere (a split, a transfer, the other outcome). We cannot
    // price its cost, so it is skipped rather than booked at zero — booking it
    // at zero would credit the whole proceeds as profit.
    let left = t.tokens;
    const queue = lots.get(t.tokenId) || [];
    while (left > 1e-9 && queue.length) {
      const lot = queue[0];
      const take = Math.min(left, lot.tokens);
      realized += take * (t.price - lot.price);
      closedCost += take * lot.price;
      lot.tokens -= take;
      left -= take;
      if (lot.tokens <= 1e-9) queue.shift();
      roundTrips++;
    }
  }

  let openCost = 0, openTokens = 0;
  for (const queue of lots.values()) {
    for (const lot of queue) { openCost += lot.tokens * lot.price; openTokens += lot.tokens; }
  }
  return { realized, closedCost, openCost, openTokens, trades: trades.length, roundTrips };
}

/**
 * The same FIFO walk, but everything still open is LIQUIDATED at the edge of the
 * window at the last price the tape printed.
 *
 * This exists because closed-round-trip P&L alone is not a measure of skill — it
 * is a measure of what somebody chose to close. Banking winners and sitting on
 * losers produces a beautiful record by construction, and because that is a
 * stable habit rather than an ability, it reproduces out of sample and looks
 * exactly like a persistent edge. Measured on this data the top of the ranking
 * left 0.653 of its capital unclosed against 0.338 for everyone else, so the
 * habit was not hypothetical.
 *
 * Marking everything to the last traded price is the ordinary convention in
 * trader-ranking studies and it removes the advantage immediately. It is not the
 * TRUE terminal value — that needs the market's on-chain resolution — but it
 * costs nothing and it is unbiased with respect to the habit, which is the point.
 *
 * @param {(tokenId: string) => number|null} markFor  last price at the edge
 * @returns {{realized, unrealized, closedCost, openCost, markedCost, unmarkableCost, ...}}
 */
export function markedPnl(trades, markFor) {
  const lots = new Map();
  let realized = 0, closedCost = 0, roundTrips = 0;

  for (const t of trades) {
    if (t.side === "buy") {
      if (!lots.has(t.tokenId)) lots.set(t.tokenId, []);
      lots.get(t.tokenId).push({ tokens: t.tokens, price: t.price });
      continue;
    }
    let left = t.tokens;
    const queue = lots.get(t.tokenId) || [];
    while (left > 1e-9 && queue.length) {
      const lot = queue[0];
      const take = Math.min(left, lot.tokens);
      realized += take * (t.price - lot.price);
      closedCost += take * lot.price;
      lot.tokens -= take;
      left -= take;
      if (lot.tokens <= 1e-9) queue.shift();
      roundTrips++;
    }
  }

  let unrealized = 0, markedCost = 0, unmarkableCost = 0, openCost = 0;
  for (const [tokenId, queue] of lots) {
    const mark = markFor(tokenId);
    for (const lot of queue) {
      const cost = lot.tokens * lot.price;
      openCost += cost;
      // A token the tape never printed at or before the edge cannot be marked.
      // Its cost is reported separately rather than assumed worthless or
      // assumed whole — either assumption would be a thumb on the scale.
      if (mark == null) { unmarkableCost += cost; continue; }
      markedCost += cost;
      unrealized += lot.tokens * (mark - lot.price);
    }
  }

  return {
    realized, unrealized, closedCost, openCost, markedCost, unmarkableCost,
    trades: trades.length, roundTrips,
    // The whole book, liquidated at the edge: what the wallet actually made on
    // the money it actually committed.
    total: realized + unrealized,
    totalCost: closedCost + markedCost,
  };
}

/** Return on committed capital with everything liquidated at the edge. */
export function markedScore(p) {
  if (!(p.totalCost > 0)) return null;
  return {
    roi: p.total / p.totalCost,
    total: p.total, totalCost: p.totalCost,
    realizedShare: p.totalCost > 0 ? p.closedCost / p.totalCost : 0,
    unmarkableShare: p.openCost > 0 ? p.unmarkableCost / p.openCost : 0,
    trades: p.trades,
  };
}

/**
 * A price book over every fill we hold: token → the last price at or before a
 * moment. Built once and binary-searched, because the study asks for it at
 * several cut-off dates.
 */
export function priceBook(allTrades) {
  const byToken = new Map();
  for (const t of allTrades) {
    if (!byToken.has(t.tokenId)) byToken.set(t.tokenId, []);
    byToken.get(t.tokenId).push([t.ts, t.price]);
  }
  for (const arr of byToken.values()) arr.sort((a, b) => a[0] - b[0]);
  return {
    tokens: byToken.size,
    /** Last printed price at or before `at`; null if the token never printed by then. */
    at(tokenId, at) {
      const arr = byToken.get(tokenId);
      if (!arr || !arr.length || arr[0][0] > at) return null;
      let lo = 0, hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid][0] <= at) lo = mid + 1; else hi = mid;
      }
      return arr[lo - 1][1];
    },
  };
}

/**
 * The headline number per wallet: return on the capital it actually put at risk
 * in closed trades.
 *
 * Deliberately NOT "profit in dollars". Dollars rank by size, and the question
 * is whether an EDGE persists — a wallet that turns $10 into $11 is more
 * interesting than one that turns $1m into $1.01m, and a copier can size either.
 * `closedCost` is the denominator because it is the money that was genuinely
 * committed and returned.
 */
export function walletScore(pnl) {
  if (!(pnl.closedCost > 0)) return null;
  return {
    roi: pnl.realized / pnl.closedCost,
    realized: pnl.realized,
    closedCost: pnl.closedCost,
    openShare: pnl.openCost / (pnl.closedCost + pnl.openCost),
    trades: pnl.trades,
    roundTrips: pnl.roundTrips,
  };
}

/** Split a wallet's trades at a unix-second cutoff. */
export function splitAt(trades, tSplit) {
  const inSample = [], outSample = [];
  for (const t of trades) (t.ts < tSplit ? inSample : outSample).push(t);
  return { inSample, outSample };
}
