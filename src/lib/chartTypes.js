// Chart series types selectable in the UI and the transforms they need.
// lightweight-charts has native candlestick/bar/line/area series; Heikin-Ashi
// is a candlestick series fed transformed OHLC values.

export const CHART_TYPES = [
  { id: "candles", label: "Kerzen" },
  { id: "heikin", label: "Heikin-Ashi" },
  { id: "bars", label: "Bars" },
  { id: "line", label: "Linie" },
  { id: "area", label: "Area" },
];

// Heikin-Ashi smoothing. Returns candles in the same shape; each HA bar:
//   close = (O+H+L+C)/4
//   open  = (prevHAopen + prevHAclose)/2
//   high  = max(H, HAopen, HAclose);  low = min(L, HAopen, HAclose)
export function heikinAshi(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? (c.open + c.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({
      time: c.time,
      open: haOpen,
      high: Math.max(c.high, haOpen, haClose),
      low: Math.min(c.low, haOpen, haClose),
      close: haClose,
      volume: c.volume,
    });
  }
  return out;
}

// Map a candle array to the data shape a given series type expects.
export function toSeriesData(type, candles) {
  if (type === "line" || type === "area") {
    return candles.map((c) => ({ time: c.time, value: c.close }));
  }
  const src = type === "heikin" ? heikinAshi(candles) : candles;
  return src.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
}
