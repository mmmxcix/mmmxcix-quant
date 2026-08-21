// Live quote store — the last traded price and best bid/ask for the symbol the
// chart is currently streaming.
//
// Why this is not React state: quotes arrive from Binance dozens of times a
// second. Holding the tick in Charts.jsx page state re-rendered the entire
// chart tree (candle chart, indicator panes, bias section, draw layers) on
// every single tick, and one of those renders costs far more than a frame — so
// the price visibly refreshed only ~3x/s with gaps over a second, well under
// what the feed delivers. Keeping the quote in a tiny external store means a
// tick re-renders only the price header, and the chart patches its forming
// candle imperatively with no render at all.

const EMPTY = { last: null, bid: null, ask: null, mid: null, at: 0 };

// Which number the UI shows as "the price".
//   "last" — last traded price. Matches the candle's close, so the big number
//            and the C in the OHLC row always agree. Moves whenever a trade
//            prints (~50x/s on a major pair).
//   "mid"  — midpoint of the best bid/ask, which is what a broker front-end
//            like UpsideOnly displays. Keeps moving even when the tape is
//            quiet, at the cost of no longer matching the candle close.
// Either way the book is streamed, so the mid is the fallback whenever no
// trade has printed yet.
export const LIVE_PRICE_SOURCE = "last"; // "last" | "mid"

export function livePriceOf(q) {
  if (!q) return null;
  if (LIVE_PRICE_SOURCE === "mid" && q.mid > 0) return q.mid;
  if (q.last > 0) return q.last;
  return q.mid > 0 ? q.mid : null;
}

let quote = EMPTY;
const subscribers = new Set();

// Merge a partial update (trade tick or book update) into the current quote.
// Subscribers are notified only when the *displayed* price actually moved:
// book updates outnumber trades several times over, and waking the header for
// a bid/ask change it does not show would put the re-render cost straight back.
export function setLiveQuote(patch) {
  const next = { ...quote, ...patch };
  if (next.bid > 0 && next.ask > 0) next.mid = (next.bid + next.ask) / 2;
  const before = livePriceOf(quote);
  quote = next;
  if (livePriceOf(next) !== before) {
    for (const fn of subscribers) fn();
  }
}

export function resetLiveQuote() {
  if (quote === EMPTY) return;
  quote = EMPTY;
  for (const fn of subscribers) fn();
}

export function getLiveQuote() {
  return quote;
}

export function subscribeLiveQuote(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
