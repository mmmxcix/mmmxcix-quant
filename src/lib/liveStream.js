// Binance kline WebSocket — real-time candle updates for crypto. Binance pushes
// the currently-forming candle on every tick (and a final message with k.x=true
// when it closes). We normalize each message to our candle shape plus a
// `closed` flag and hand it to onCandle. Handles auto-reconnect with backoff.
//
// The Cloudflare CSP must allow `wss://stream.binance.com:9443` in connect-src
// (see public/_headers) or the browser blocks this connection.

const WS_BASE = "wss://stream.binance.com:9443/ws";

// Minimum ms between tick callbacks — every executed trade arrives on the
// aggTrade stream (can be dozens/second on majors). Ticks only repaint the
// forming candle imperatively, so a fast cadence stays cheap; 120ms (~8/s)
// reads as smoothly live like a pro terminal.
const TICK_THROTTLE_MS = 120;

export function openBinanceKlineStream({ symbol, interval, onCandle, onTick, onStatus }) {
  // Combined stream: kline (authoritative candle) + aggTrade (instant price).
  const streamName = onTick
    ? `${symbol.toLowerCase()}@kline_${interval}/${symbol.toLowerCase()}@aggTrade`
    : `${symbol.toLowerCase()}@kline_${interval}`;
  let lastTickAt = 0;
  let ws = null;
  let closedByUs = false;
  let retry = 0;
  let reconnectTimer = null;

  const connect = () => {
    try {
      // Single stream uses the raw endpoint; multiple streams need the
      // combined endpoint, which wraps payloads in { stream, data }.
      ws = new WebSocket(onTick
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

      // aggTrade: instant last price, throttled.
      if (payload?.e === "aggTrade" && onTick) {
        const now = Date.now();
        if (now - lastTickAt >= TICK_THROTTLE_MS) {
          lastTickAt = now;
          onTick(+payload.p);
        }
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
