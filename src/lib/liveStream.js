// Binance kline WebSocket — real-time candle updates for crypto. Binance pushes
// the currently-forming candle on every tick (and a final message with k.x=true
// when it closes). We normalize each message to our candle shape plus a
// `closed` flag and hand it to onCandle. Handles auto-reconnect with backoff.
//
// Three streams are combined when a live price is wanted:
//   @kline_<iv>  authoritative candle (open/high/low/close/volume)
//   @aggTrade    last traded price — moves only when a trade prints
//   @bookTicker  best bid/ask — moves on every book change, many times a second
// The book is what makes the displayed price tick as continuously as a broker
// terminal; the trade tape alone leaves the number frozen for stretches of a
// second or more even on a liquid pair.
//
// The Cloudflare CSP must allow `wss://stream.binance.com:9443` in connect-src
// (see public/_headers) or the browser blocks this connection.

const WS_BASE = "wss://stream.binance.com:9443/ws";

// Quotes arrive faster than any screen can show them, so they are coalesced
// rather than dropped: the newest value is kept and flushed on the next
// animation frame. The old fixed 120ms leading-edge throttle discarded every
// update inside its window, which meant the newest print was routinely the one
// thrown away and the price sat visibly stale. rAF also parks itself while the
// tab is hidden and resumes with the latest value on return.
const raf = typeof requestAnimationFrame === "function"
  ? requestAnimationFrame
  : (fn) => setTimeout(fn, 16);
const cancelRaf = typeof cancelAnimationFrame === "function"
  ? cancelAnimationFrame
  : clearTimeout;

export function openBinanceKlineStream({ symbol, interval, onCandle, onTick, onQuote, onStatus }) {
  const wantsPrice = Boolean(onTick || onQuote);
  const s = symbol.toLowerCase();
  const streamName = wantsPrice
    ? `${s}@kline_${interval}/${s}@aggTrade/${s}@bookTicker`
    : `${s}@kline_${interval}`;

  // Coalesced quote state: overwritten as fast as messages land, flushed once
  // per frame so the UI always paints the newest value it could have.
  let pendingTick = null;
  let pendingQuote = null;
  let frame = 0;
  const flush = () => {
    frame = 0;
    if (pendingTick != null) { const p = pendingTick; pendingTick = null; onTick?.(p); }
    if (pendingQuote != null) { const q = pendingQuote; pendingQuote = null; onQuote?.(q); }
  };
  const schedule = () => { if (!frame) frame = raf(flush); };
  let ws = null;
  let closedByUs = false;
  let retry = 0;
  let reconnectTimer = null;

  const connect = () => {
    try {
      // Single stream uses the raw endpoint; multiple streams need the
      // combined endpoint, which wraps payloads in { stream, data }.
      ws = new WebSocket(wantsPrice
        ? `wss://stream.binance.com:9443/stream?streams=${streamName}`
        : `${WS_BASE}/${streamName}`);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => { retry = 0; onStatus?.("live"); };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const payload = msg?.data ?? msg; // combined vs raw format

      // aggTrade: last traded price.
      if (payload?.e === "aggTrade" && wantsPrice) {
        pendingTick = +payload.p;
        schedule();
        return;
      }

      // bookTicker: best bid/ask. It carries no `e` event-type field, so it is
      // identified by the stream name (combined format) or by its shape.
      if (wantsPrice && payload?.e === undefined && payload?.b !== undefined && payload?.a !== undefined) {
        const bid = +payload.b;
        const ask = +payload.a;
        if (bid > 0 && ask > 0) { pendingQuote = { bid, ask }; schedule(); }
        return;
      }

      const k = payload?.k;
      if (!k) return;
      onCandle({
        time: Math.floor(k.t / 1000),
        open: +k.o,
        high: +k.h,
        low: +k.l,
        close: +k.c,
        volume: +k.v,
        closed: Boolean(k.x),
      });
    };

    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };

    ws.onclose = () => {
      if (closedByUs) return;
      onStatus?.("reconnecting");
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    retry += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(retry, 5)); // 2s→32s cap
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  };

  connect();

  // Returns a cleanup function.
  return () => {
    closedByUs = true;
    clearTimeout(reconnectTimer);
    if (frame) { cancelRaf(frame); frame = 0; }
    pendingTick = null;
    pendingQuote = null;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { ws.close(); } catch { /* ignore */ }
    }
  };
}

// Merge a live candle into an ascending candle array: replace the bar with the
// same open-time, or append if it's newer. Never inserts before the first bar
// (so a live update can't trigger the chart's prepend/history path). Returns
// the same array reference when nothing changed (lets React skip re-render).
export function mergeLiveCandle(prev, live) {
  if (!prev || prev.length === 0) return prev;
  const firstTime = prev[0].time;
  if (live.time < firstTime) return prev;
  const last = prev[prev.length - 1];

  if (live.time === last.time) {
    if (last.close === live.close && last.high === live.high && last.low === live.low && last.volume === live.volume) {
      return prev; // no visible change
    }
    const next = prev.slice();
    next[next.length - 1] = { time: live.time, open: live.open, high: live.high, low: live.low, close: live.close, volume: live.volume };
    return next;
  }
  if (live.time > last.time) {
    return [...prev, { time: live.time, open: live.open, high: live.high, low: live.low, close: live.close, volume: live.volume }];
  }
  return prev; // older than last but >= first: ignore (already settled)
}

// Merge a live TICK price into the forming (last) candle: update close and
// stretch high/low. The kline stream remains authoritative — the next kline
// message overwrites whatever the ticks painted.
export function mergeTickPrice(prev, price) {
  if (!prev || prev.length === 0 || !(price > 0)) return prev;
  const last = prev[prev.length - 1];
  if (last.close === price && price <= last.high && price >= last.low) return prev;
  const next = prev.slice();
  next[next.length - 1] = {
    ...last,
    close: price,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
  };
  return next;
}
