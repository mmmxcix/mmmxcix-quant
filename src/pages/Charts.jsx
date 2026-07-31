import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { TrendingUp, Minus, MoveHorizontal, AlignVerticalJustifyCenter, Square, GitBranch, Trash2, Pencil, Magnet, Wand2 } from "lucide-react";
import CandleChart from "@/components/CandleChart";
import SymbolSearch from "@/components/SymbolSearch";
import ChartDrawLayer, { DRAW_TOOLS } from "@/components/ChartDrawLayer";
import AutoAnnotateLayer from "@/components/AutoAnnotateLayer";
import BiasPanel from "@/components/BiasPanel";
import SymbolInfoPanel from "@/components/SymbolInfoPanel";
import IndicatorPane from "@/components/IndicatorPane";
import { fetchCandles, fetchOlderCandles, fetchLatestCandles, MARKETS, INTERVALS, rangesFor } from "@/lib/data";
import { openBinanceKlineStream, mergeLiveCandle } from "@/lib/liveStream";
import { CHART_TYPES } from "@/lib/chartTypes";
import { sma, ema, bollinger, closes } from "@/lib/indicators";
import { vizColor } from "@/lib/vizColors";
import { getAlertsFor, addAlert, removeAlert, subscribeAlerts, checkAlerts, ensureNotificationPermission } from "@/lib/alerts";
import { cn, fmtPrice, fmtPct } from "@/lib/utils";
import { Bell, X, Scale, Info as InfoIcon, Radio } from "lucide-react";

// Compact price header above the chart — last price (live tick if streaming),
// change vs the previous bar, and the current bar's OHLC.
function PriceHeader({ candles, livePrice }) {
  if (!candles || candles.length < 2) return null;
  const bar = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const px = livePrice ?? bar.close;
  const ch = prev.close ? ((px - prev.close) / prev.close) * 100 : 0;
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 px-1 pb-3 mb-3 border-b border-line">
      <span className="font-mono text-2xl sm:text-3xl font-bold tabular-nums leading-none">{fmtPrice(px)}</span>
      <span className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-mono font-semibold tabular-nums",
        ch >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down"
      )}>
        {ch >= 0 ? "▲" : "▼"} {fmtPct(ch)}
      </span>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-dim sm:ml-auto">
        <span>O <b className="text-text font-semibold">{fmtPrice(bar.open)}</b></span>
        <span>H <b className="text-text font-semibold">{fmtPrice(bar.high)}</b></span>
        <span>L <b className="text-text font-semibold">{fmtPrice(bar.low)}</b></span>
        <span>C <b className="text-text font-semibold">{fmtPrice(bar.close)}</b></span>
      </div>
    </div>
  );
}

const DEFAULT_SYMBOL = { crypto: "BTCUSDT", stock: "AAPL" };
const DRAW_COLORS = ["#38bdf8", "#f59e0b", "#f472b6", "#a78bfa", "#10b981", "#ef4444"];

// The chart reopens on whatever you looked at last (market, symbol, timeframe).
const LAST_CHART_KEY = "quant_last_chart";
function loadLastChart() {
  try { return JSON.parse(localStorage.getItem(LAST_CHART_KEY)) || {}; } catch { return {}; }
}

// Map the DRAW_TOOLS icon names to their imported components (avoids pulling
// in the entire lucide-react namespace, which triples the bundle).
const TOOL_ICONS = { TrendingUp, Minus, MoveHorizontal, AlignVerticalJustifyCenter, Square, GitBranch, Trash2 };

// Fill most of the viewport on large screens without squashing laptops.
function chartHeight() {
  if (typeof window === "undefined") return 520;
  const h = window.innerHeight;
  // Shorter on phones so controls + chart both fit without excessive scroll.
  if (window.innerWidth < 640) return Math.min(420, Math.max(300, h - 360));
  return Math.min(760, Math.max(440, h - 420));
}

// How often to poll the latest candle, by interval. Fast timeframes update
// near-real-time; slow ones need only the occasional refresh.
function pollMs(interval) {
  if (interval === "1s") return 2000;
  if (["1m", "5m"].includes(interval)) return 10000;
  if (["15m", "30m", "1h", "2h", "4h"].includes(interval)) return 30000;
  return 60000; // daily / weekly / monthly
}

export default function Charts() {
  const [params, setParams] = useSearchParams();
  // Priority: explicit URL params (links from Screener/Watchlist) → the last
  // symbol you looked at (persisted) → defaults.
  const stored = useMemo(loadLastChart, []);
  const market = params.get("market") || stored.market || "crypto";
  const symbol =
    params.get("symbol") ||
    (stored.market === market && stored.symbol ? stored.symbol : null) ||
    DEFAULT_SYMBOL[market];

  const [interval, setIntervalId] = useState(() => stored.interval || "1d");
  const [range, setRange] = useState(() => stored.range || "1y");
  const [chartType, setChartType] = useState("candles");
  const [indicators, setIndicators] = useState({ sma2050: false, ema200: false, bollinger: false });
  const [panes, setPanes] = useState({ rsi: false, macd: false }); // oscillator sub-charts
  const [candles, setCandles] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(false); // WS connected (crypto real-time)
  const [livePrice, setLivePrice] = useState(null); // latest tick, drives the forming candle only
  const [mainChart, setMainChart] = useState(null); // for pane time-sync
  const [mainSeries, setMainSeries] = useState(null); // for alert price lines

  // Price alerts
  const [alerts, setAlerts] = useState([]);
  const [alertPrice, setAlertPrice] = useState("");
  const [showAlertBox, setShowAlertBox] = useState(false);
  const [toast, setToast] = useState(null);

  // Drawing state
  const [activeTool, setActiveTool] = useState(null);
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);
  const [magnet, setMagnet] = useState(false); // crosshair + drawings snap to candles (opt-in)
  // Auto-annotation: the app detects and draws these from the data itself.
  const [autoDraw, setAutoDraw] = useState({ levels: false, trend: false, fvg: false, fib: false, patterns: false });

  // Rule-based bias readout (mechanical long/short/neutral + SL/TP levels).
  const [showBias, setShowBias] = useState(false);
  // "What is this symbol?" — profile + fundamentals panel.
  const [showInfo, setShowInfo] = useState(false);

  // Esc cancels an active drawing tool.
  useEffect(() => {
    if (!activeTool) return;
    const onKey = (e) => { if (e.key === "Escape") setActiveTool(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool]);

  const chartKey = `${market}:${symbol}`;

  // Remember what's on screen so the page reopens exactly here next time.
  useEffect(() => {
    try {
      localStorage.setItem(LAST_CHART_KEY, JSON.stringify({ market, symbol, interval, range }));
    } catch { /* private mode */ }
  }, [market, symbol, interval, range]);

  // Keep interval/range valid together: switching to an intraday interval
  // must snap the range into the allowed set for that interval. Market matters
  // too (Yahoo caps stock 1m at 8 days; Binance doesn't).
  const validRanges = useMemo(() => rangesFor(interval, market), [interval, market]);
  useEffect(() => {
    if (!validRanges.some((r) => r.id === range)) {
      setRange(validRanges[validRanges.length > 2 ? Math.floor(validRanges.length / 2) : 0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, market]);

  // If the current interval isn't available for this market, fall back to 1d.
  const availableIntervals = useMemo(
    () => INTERVALS.filter((i) => i.markets.includes(market)),
    [market]
  );
  useEffect(() => {
    if (!availableIntervals.some((i) => i.id === interval)) setIntervalId("1d");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchCandles({ market, symbol, interval, range })
      .then((c) => { if (alive) setCandles(c); })
      .catch((e) => { if (alive) { setError(e.message); setCandles(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [market, symbol, interval, range]);

  const loadOlder = useCallback(async () => {
    let added = 0;
    const first = candles?.[0];
    if (!first) return 0;
    const older = await fetchOlderCandles({ market, symbol, interval, before: first.time });
    const fresh = older.filter((c) => c.time < first.time);
    if (fresh.length > 0) {
      added = fresh.length;
      setCandles((prev) => (prev && prev[0]?.time === first.time ? [...fresh, ...prev] : prev));
    }
    return added;
  }, [candles, market, symbol, interval]);

  // Live updates. Crypto uses the Binance WebSocket (real-time ticks); stocks
  // have no free realtime feed, so they poll the latest candle on an interval
  // scaled to the timeframe. Only runs once initial data has loaded.
  const hasData = candles !== null;
  useEffect(() => {
    if (!hasData) return;
    setLive(false);

    if (market === "crypto") {
      const bIv = INTERVALS.find((i) => i.id === interval)?.binance;
      if (!bIv) return;
      const close = openBinanceKlineStream({
        symbol,
        interval: bIv,
        onCandle: (c) => setCandles((prev) => mergeLiveCandle(prev, c)),
        // Every trade updates only the forming candle (imperative series.update
        // in CandleChart) — no page re-render, so it ticks smoothly like a pro
        // terminal. The kline stream keeps the array authoritative.
        onTick: (price) => setLivePrice(price),
        onStatus: (s) => setLive(s === "live"),
      });
      return () => { close(); setLive(false); setLivePrice(null); };
    }

    // Stocks: polling fallback.
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      const latest = await fetchLatestCandles({ market, symbol, interval });
      if (!alive || latest.length === 0) return;
      setCandles((prev) => {
        let next = prev;
        for (const c of latest) next = mergeLiveCandle(next, c);
        return next;
      });
    };
    const id = setInterval(tick, pollMs(interval));
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, symbol, interval, hasData]);

  // Alerts: load for this symbol + stay in sync with storage changes.
  useEffect(() => {
    const refresh = () => setAlerts(getAlertsFor(market, symbol));
    refresh();
    return subscribeAlerts(refresh);
  }, [market, symbol]);

  // Check alerts against the latest price on every candle update. Show a toast
  // for any that fire (checkAlerts also handles the browser notification).
  const lastClose = candles && candles.length ? candles[candles.length - 1].close : null;
  useEffect(() => {
    if (lastClose == null) return;
    const fired = checkAlerts(market, symbol, lastClose);
    if (fired.length > 0) {
      const a = fired[0];
      setToast(`Alert: ${a.symbol} ${a.direction === "above" ? "above" : "below"} ${a.price}`);
      setTimeout(() => setToast(null), 6000);
    }
  }, [lastClose, market, symbol]);

  // Draw a dashed price line on the chart for each active (untriggered) alert.
  useEffect(() => {
    if (!mainSeries) return;
    const lines = alerts
      .filter((a) => !a.triggered)
      .map((a) =>
        mainSeries.createPriceLine({
          price: a.price,
          color: a.direction === "above" ? "#10b981" : "#ef4444",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "Alert",
        })
      );
    return () => { lines.forEach((l) => { try { mainSeries.removePriceLine(l); } catch { /* gone */ } }); };
  }, [alerts, mainSeries]);

  // A trade handed over from Argus (click a thesis) or a backtest link: its
  // entry / stop / target become price lines with a marker + the reason Argus
  // gave, so you see exactly what the agent did on the real chart. Params are
  // namespaced (t*) so they never collide with the alert lines. Declared BEFORE
  // the price-line effect below — its dependency array reads `trade` at render.
  const trade = useMemo(() => {
    const entry = parseFloat(params.get("tEntry"));
    if (!Number.isFinite(entry)) return null;
    const num = (k) => { const v = parseFloat(params.get(k)); return Number.isFinite(v) ? v : null; };
    return {
      entry,
      stop: num("tStop"),
      target: num("tTarget"),
      side: params.get("tSide") === "short" ? "short" : "long",
      at: num("tAt"), // entry time (unix seconds)
      reason: params.get("tReason") || "",
      label: params.get("tLabel") || "",
      outcome: params.get("tOutcome") || "", // open | planned | target | stop | signal | eod
    };
  }, [params]);

  const tradeMarkers = useMemo(() => {
    if (!trade?.at) return [];
    return [{ time: trade.at, side: trade.side === "long" ? "buy" : "sell", text: `Argus ${trade.side}` }];
  }, [trade]);

  // A Lab-agent STRATEGY's full trade log handed over (click a strategy row):
  // a buy/sell arrow at every entry AND exit, so you see exactly when it longed
  // or shorted and when it closed. Compact param tTrades = [{a,x,s,e,p}] with
  // a=entry time, x=exit time (unix SECONDS), s=side, e/p=entry/exit price.
  const stratName = params.get("tName") || "";
  const stratTrades = useMemo(() => {
    const raw = params.get("tTrades");
    if (!raw) return null;
    try { const arr = JSON.parse(raw); return Array.isArray(arr) && arr.length ? arr : null; }
    catch { return null; }
  }, [params]);

  const stratMarkers = useMemo(() => {
    if (!stratTrades) return [];
    const out = [];
    for (const t of stratTrades) {
      const long = t.s !== "short";
      if (t.a) out.push({ time: t.a, side: long ? "buy" : "sell", text: long ? "Long" : "Short" });
      if (t.x) out.push({ time: t.x, side: long ? "sell" : "buy", text: "Close" });
    }
    return out.sort((a, b) => a.time - b.time);
  }, [stratTrades]);

  const allMarkers = useMemo(
    () => (stratMarkers.length ? stratMarkers : tradeMarkers),
    [stratMarkers, tradeMarkers]
  );

  const clearTrade = () => {
    const next = new URLSearchParams(params);
    ["tEntry", "tStop", "tTarget", "tSide", "tAt", "tReason", "tLabel", "tOutcome", "tTrades", "tName"].forEach((k) => next.delete(k));
    setParams(next);
  };

  // Entry / stop / target lines for a handed-over trade — solid, labelled, so
  // it reads like a real order ticket sitting on the chart.
  useEffect(() => {
    if (!mainSeries || !trade) return;
    const lines = [];
    const add = (price, color, title) => {
      if (price == null) return;
      lines.push(mainSeries.createPriceLine({ price, color, lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title }));
    };
    add(trade.entry, "#3b82f6", `Entry (${trade.side})`);
    add(trade.stop, "#ef4444", "Stop");
    add(trade.target, "#10b981", "Target");
    return () => { lines.forEach((l) => { try { mainSeries.removePriceLine(l); } catch { /* gone */ } }); };
  }, [trade, mainSeries]);

  const submitAlert = async (direction) => {
    const p = parseFloat(alertPrice);
    if (!p || p <= 0) return;
    await ensureNotificationPermission();
    addAlert({ market, symbol, price: p, direction });
    setAlertPrice("");
    setShowAlertBox(false);
  };

  const overlays = useMemo(() => {
    if (!candles) return [];
    const cl = closes(candles);
    const mk = (values, color, label) => ({
      label, color,
      points: values.map((v, i) => (v === null ? null : { time: candles[i].time, value: v })).filter(Boolean),
    });
    const out = [];
    if (indicators.sma2050) out.push(mk(sma(cl, 20), vizColor("blue"), "SMA 20"), mk(sma(cl, 50), vizColor("amber"), "SMA 50"));
    if (indicators.ema200) out.push(mk(ema(cl, 200), vizColor("purple"), "EMA 200"));
    if (indicators.bollinger) {
      const bb = bollinger(cl, 20, 2);
      const band = (key, color) => ({
        label: `BB ${key}`, color,
        points: bb.map((v, i) => (v === null ? null : { time: candles[i].time, value: v[key] })).filter(Boolean),
      });
      out.push(band("upper", "#64748b"), band("mid", "#64748b99"), band("lower", "#64748b"));
    }
    return out;
  }, [candles, indicators]);

  const stats = useMemo(() => {
    if (!candles || candles.length < 2) return null;
    const last = candles[candles.length - 1];
    const first = candles[0];
    return {
      price: last.close,
      changePct: ((last.close - first.close) / first.close) * 100,
      high: Math.max(...candles.map((c) => c.high)),
      low: Math.min(...candles.map((c) => c.low)),
    };
  }, [candles]);

  const switchMarket = (m) => {
    if (m !== market) setParams({ market: m, symbol: DEFAULT_SYMBOL[m] });
  };

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Market data</p>
      <h1 className="text-xl sm:text-2xl font-bold mb-4 sm:mb-6">Charts</h1>

      <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4">
        <div className="flex gap-1">
          {MARKETS.map((m) => (
            <button key={m.id} onClick={() => switchMarket(m.id)}
              className={cn("chip", market === m.id ? "chip-active" : "chip-idle")}>
              {m.label}
            </button>
          ))}
        </div>
        <SymbolSearch
          market={market}
          value={symbol}
          onSelect={(s) => setParams({ market, symbol: s })}
          placeholder={market === "crypto" ? "e.g. Bitcoin or BTCUSDT" : "e.g. Apple or AAPL"}
          className="w-full sm:w-64"
        />
      </div>

      {/* Timeframes + ranges */}
      <div className="flex flex-wrap items-center gap-1 mb-3">
        {availableIntervals.map((i) => (
          <button key={i.id} onClick={() => setIntervalId(i.id)}
            className={cn("chip font-mono", interval === i.id ? "chip-active" : "chip-idle")}>
            {i.label}
          </button>
        ))}
        <span className="mx-2 h-4 w-px bg-line" />
        {validRanges.map((r) => (
          <button key={r.id} onClick={() => setRange(r.id)}
            className={cn("chip font-mono", range === r.id ? "chip-active" : "chip-idle")}>
            {r.label}
          </button>
        ))}
      </div>

      {/* Chart type + indicators + drawing tools */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
        <div className="flex gap-1">
          {CHART_TYPES.map((t) => (
            <button key={t.id} onClick={() => setChartType(t.id)}
              className={cn("chip", chartType === t.id ? "chip-active" : "chip-idle")}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-dim">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={indicators.sma2050}
              onChange={(e) => setIndicators((v) => ({ ...v, sma2050: e.target.checked }))}
              className="accent-accent" />
            SMA 20/50
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={indicators.ema200}
              onChange={(e) => setIndicators((v) => ({ ...v, ema200: e.target.checked }))}
              className="accent-accent" />
            EMA 200
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={indicators.bollinger}
              onChange={(e) => setIndicators((v) => ({ ...v, bollinger: e.target.checked }))}
              className="accent-accent" />
            Bollinger
          </label>
          <span className="h-3 w-px bg-line" />
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={panes.rsi}
              onChange={(e) => setPanes((v) => ({ ...v, rsi: e.target.checked }))}
              className="accent-accent" />
            RSI
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={panes.macd}
              onChange={(e) => setPanes((v) => ({ ...v, macd: e.target.checked }))}
              className="accent-accent" />
            MACD
          </label>
        </div>

        {/* Auto-draw: the app detects and draws these from the data itself */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-dim">
          <span className="flex items-center gap-1" style={{ color: "var(--viz-purple)" }} title="Automatically detected and drawn from the data">
            <Wand2 className="w-3.5 h-3.5" /> Auto
          </span>
          {[
            ["levels", "S/R levels"],
            ["trend", "Trendlines"],
            ["fvg", "FVG"],
            ["fib", "Fibonacci"],
            ["patterns", "Patterns"],
          ].map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" checked={autoDraw[key]}
                onChange={(e) => setAutoDraw((v) => ({ ...v, [key]: e.target.checked }))}
                style={{ accentColor: "var(--viz-purple)" }} />
              {label}
            </label>
          ))}
        </div>

        {/* Drawing toolbar */}
        <div className="flex items-center gap-1 sm:ml-auto">
          <button
            title={magnet
              ? "Magnet on: drawing points snap to O/H/L/C, crosshair price sticks to the close"
              : "Magnet off: free drawing, crosshair price follows the mouse"}
            onClick={() =>
              setMagnet((v) => {
                const next = !v;
                setToast(next
                  ? "Magnet ON — drawing points snap to candle O/H/L/C, crosshair price sticks to the close"
                  : "Magnet OFF — drawings place freely, crosshair price follows the mouse");
                setTimeout(() => setToast(null), 3500);
                return next;
              })
            }
            className={cn(
              "p-2 sm:p-1.5 rounded-md border transition-colors",
              magnet ? "border-accent/60 text-accent bg-accent/10" : "border-line text-dim hover:text-text"
            )}
          >
            <Magnet className="w-4 h-4" />
          </button>
          <span className="h-4 w-px bg-line mx-0.5" />
          {DRAW_TOOLS.map((tool) => {
            const Icon = TOOL_ICONS[tool.icon] || Pencil;
            const isActive = activeTool === tool.id && tool.id !== "clear";
            return (
              <button
                key={tool.id}
                title={tool.label}
                onClick={() => setActiveTool((cur) => (tool.id === "clear" ? "clear" : cur === tool.id ? null : tool.id))}
                className={cn(
                  "p-2 sm:p-1.5 rounded-md border transition-colors",
                  isActive ? "border-accent/60 text-accent bg-accent/10"
                    : tool.id === "clear" ? "border-line text-dim hover:text-down hover:border-down/40"
                    : "border-line text-dim hover:text-text"
                )}
              >
                <Icon className="w-4 h-4" />
              </button>
            );
          })}
          <div className="flex items-center gap-1.5 sm:gap-1 ml-1">
            {DRAW_COLORS.map((c) => (
              <button key={c} onClick={() => setDrawColor(c)} title="Drawing color"
                className={cn("w-5 h-5 sm:w-4 sm:h-4 rounded-full border", drawColor === c ? "border-white" : "border-transparent")}
                style={{ background: c }} />
            ))}
          </div>
        </div>
      </div>

      {stats && (
        <div className="flex flex-wrap gap-x-5 sm:gap-x-8 gap-y-2 mb-4 text-xs sm:text-sm font-mono">
          <div><span className="text-dim mr-2">Price</span>{fmtPrice(stats.price)}</div>
          <div>
            <span className="text-dim mr-2">Period</span>
            <span className={stats.changePct >= 0 ? "text-up" : "text-down"}>{fmtPct(stats.changePct)}</span>
          </div>
          <div><span className="text-dim mr-2">High</span>{fmtPrice(stats.high)}</div>
          <div><span className="text-dim mr-2">Low</span>{fmtPrice(stats.low)}</div>
          {live && (
            <div className="flex items-center gap-1.5 text-up" title="Real-time data via WebSocket">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-up opacity-60 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-up" />
              </span>
              Live
            </div>
          )}
        </div>
      )}

      {activeTool && activeTool !== "clear" && (
        <p className="text-[11px] text-accent mb-2">
          Drawing active: {DRAW_TOOLS.find((t) => t.id === activeTool)?.label} — click on the chart, Esc cancels.{" "}
          {magnet
            ? "Magnet: points snap to candle O/H/L/C (filled dot = locked)."
            : "Magnet off: free placement."}
        </p>
      )}

      {/* Price alerts */}
      <div className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setShowAlertBox((v) => !v)}
            className="flex items-center gap-1.5 chip chip-idle">
            <Bell className="w-3.5 h-3.5" /> Alert
          </button>
          <button onClick={() => setShowBias((v) => !v)}
            title="Mechanical rule check: long/short bias + suggested SL/TP from detected structure. Not investment advice."
            className={cn("flex items-center gap-1.5 chip", showBias ? "chip-active" : "chip-idle")}>
            <Scale className="w-3.5 h-3.5" /> Bias check
          </button>
          <button onClick={() => setShowInfo((v) => !v)}
            title="What is this? Company/asset profile, analyst targets, quarterly earnings (estimate vs. delivered)."
            className={cn("flex items-center gap-1.5 chip", showInfo ? "chip-active" : "chip-idle")}>
            <InfoIcon className="w-3.5 h-3.5" /> Info
          </button>
          {showAlertBox && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number" value={alertPrice} onChange={(e) => setAlertPrice(e.target.value)}
                placeholder={stats ? fmtPrice(stats.price) : "Price"}
                className="input-base font-mono w-28 text-sm"
              />
              <button onClick={() => submitAlert("above")} className="chip chip-idle text-up">↑ above</button>
              <button onClick={() => submitAlert("below")} className="chip chip-idle text-down">↓ below</button>
            </div>
          )}
          {alerts.map((a) => (
            <span key={a.id}
              className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-mono",
                a.triggered ? "border-line text-dim line-through" : a.direction === "above" ? "border-up/40 text-up" : "border-down/40 text-down")}>
              {a.direction === "above" ? "↑" : "↓"} {fmtPrice(a.price)}
              <button onClick={() => removeAlert(a.id)} className="text-dim hover:text-text" aria-label="Remove alert">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 rounded-xl border border-accent/50 bg-surface px-4 py-3 text-sm text-text shadow-lg shadow-black/40 flex items-center gap-2">
          <Bell className="w-4 h-4 text-accent" /> {toast}
        </div>
      )}

      {/* A handed-over Argus trade — its plan and the reason it was taken. */}
      {trade && (
        <div className="rounded-xl border border-accent/40 bg-accent/5 px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-[11px] uppercase tracking-wide text-accent font-semibold flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5" /> Argus {trade.side}{trade.outcome && trade.outcome !== "open" ? ` · ${trade.outcome}` : ""}
          </span>
          <span className="font-mono text-xs text-dim">
            entry <span className="text-text">{fmtPrice(trade.entry)}</span>
            {trade.stop != null && <> · <span className="text-down">stop {fmtPrice(trade.stop)}</span></>}
            {trade.target != null && <> · <span className="text-up">target {fmtPrice(trade.target)}</span></>}
          </span>
          {trade.reason && <span className="text-xs text-dim flex-1 min-w-[12rem]">{trade.reason}</span>}
          <button onClick={clearTrade} className="text-dim hover:text-text ml-auto" aria-label="Clear trade overlay"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* A handed-over Lab strategy's trade log — every entry/exit as an arrow. */}
      {stratTrades && (
        <div className="rounded-xl border border-accent/40 bg-accent/5 px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-[11px] uppercase tracking-wide text-accent font-semibold flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5" /> Lab strategy
          </span>
          {stratName && <span className="text-xs text-text font-medium">{stratName}</span>}
          <span className="font-mono text-xs text-dim">
            {stratTrades.length} trade{stratTrades.length === 1 ? "" : "s"} · ▲ long/open ▼ short/close
          </span>
          <button onClick={clearTrade} className="text-dim hover:text-text ml-auto" aria-label="Clear strategy overlay"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="rounded-xl border border-line lg-glass p-3">
        {!error && candles && <PriceHeader candles={candles} livePrice={livePrice} />}
        {error ? (
          <div className="h-96 flex items-center justify-center text-sm text-down px-6 text-center">{error}</div>
        ) : loading && !candles ? (
          <div className="h-96 flex items-center justify-center text-sm text-dim">Loading data…</div>
        ) : candles ? (
          <>
            {/* the chart builds in left-to-right when data first lands */}
            <div className="wipe-in">
            <CandleChart
              candles={candles}
              chartType={chartType}
              overlays={overlays}
              markers={allMarkers}
              height={chartHeight()}
              magnet={magnet}
              livePrice={livePrice}
              onNeedOlder={loadOlder}
              onChartReady={(chart, series) => { setMainChart(chart); setMainSeries(series); }}
            >
              {({ chart, series, containerRef }) => (
                <>
                  <AutoAnnotateLayer
                    chart={chart}
                    series={series}
                    containerRef={containerRef}
                    candles={candles}
                    show={autoDraw}
                  />
                  <ChartDrawLayer
                    chart={chart}
                    series={series}
                    containerRef={containerRef}
                    chartKey={chartKey}
                    activeTool={activeTool}
                    color={drawColor}
                    candles={candles}
                    snap={magnet}
                    onToolConsumed={() => setActiveTool(null)}
                  />
                </>
              )}
            </CandleChart>
            </div>
            {panes.rsi && <IndicatorPane candles={candles} type="rsi" mainChart={mainChart} />}
            {panes.macd && <IndicatorPane candles={candles} type="macd" mainChart={mainChart} />}
          </>
        ) : null}
      </div>

      {showInfo && <SymbolInfoPanel market={market} symbol={symbol} />}

      {showBias && (
        <div className="mt-4">
          <BiasPanel market={market} symbol={symbol} interval={interval} />
        </div>
      )}
    </div>
  );
}
