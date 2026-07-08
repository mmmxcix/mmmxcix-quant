import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { TrendingUp, Minus, MoveHorizontal, AlignVerticalJustifyCenter, Square, GitBranch, Trash2, Pencil } from "lucide-react";
import CandleChart from "@/components/CandleChart";
import SymbolSearch from "@/components/SymbolSearch";
import ChartDrawLayer, { DRAW_TOOLS } from "@/components/ChartDrawLayer";
import { fetchCandles, fetchOlderCandles, fetchLatestCandles, MARKETS, INTERVALS, rangesFor } from "@/lib/data";
import { CHART_TYPES } from "@/lib/chartTypes";
import { sma, ema, closes } from "@/lib/indicators";
import { cn, fmtPrice, fmtPct } from "@/lib/utils";

const DEFAULT_SYMBOL = { crypto: "BTCUSDT", stock: "AAPL" };
const DRAW_COLORS = ["#38bdf8", "#f59e0b", "#f472b6", "#a78bfa", "#10b981", "#ef4444"];

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
  const market = params.get("market") || "crypto";
  const symbol = params.get("symbol") || DEFAULT_SYMBOL[market];

  const [interval, setIntervalId] = useState("1d");
  const [range, setRange] = useState("1y");
  const [chartType, setChartType] = useState("candles");
  const [indicators, setIndicators] = useState({ sma2050: true, ema200: false });
  const [candles, setCandles] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Drawing state
  const [activeTool, setActiveTool] = useState(null);
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);

  const chartKey = `${market}:${symbol}`;

  // Keep interval/range valid together: switching to an intraday interval
  // must snap the range into the allowed set for that interval.
  const validRanges = useMemo(() => rangesFor(interval), [interval]);
  useEffect(() => {
    if (!validRanges.some((r) => r.id === range)) {
      setRange(validRanges[validRanges.length > 2 ? Math.floor(validRanges.length / 2) : 0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval]);

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

  // Live refresh: poll the latest candle(s) and merge them into the tail
  // (update the still-forming bar, append newly-closed ones). Only runs once
  // there is data and the tab is visible; interval scales with the timeframe.
  useEffect(() => {
    if (!candles) return;
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      const latest = await fetchLatestCandles({ market, symbol, interval });
      if (!alive || latest.length === 0) return;
      setCandles((prev) => {
        if (!prev || prev.length === 0) return prev;
        const byTime = new Map(prev.map((c) => [c.time, c]));
        let changed = false;
        for (const c of latest) {
          const existing = byTime.get(c.time);
          if (!existing || existing.close !== c.close || existing.high !== c.high || existing.low !== c.low) {
            byTime.set(c.time, c);
            changed = true;
          }
        }
        if (!changed) return prev;
        // Rebuild ascending; only accept bars at/after the current first bar
        // so a live poll never re-triggers the prepend path.
        const firstTime = prev[0].time;
        return [...byTime.values()].filter((c) => c.time >= firstTime).sort((a, b) => a.time - b.time);
      });
    };
    const id = setInterval(tick, pollMs(interval));
    return () => { alive = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, symbol, interval, candles === null]);

  const overlays = useMemo(() => {
    if (!candles) return [];
    const cl = closes(candles);
    const mk = (values, color, label) => ({
      label, color,
      points: values.map((v, i) => (v === null ? null : { time: candles[i].time, value: v })).filter(Boolean),
    });
    const out = [];
    if (indicators.sma2050) out.push(mk(sma(cl, 20), "#38bdf8", "SMA 20"), mk(sma(cl, 50), "#f59e0b", "SMA 50"));
    if (indicators.ema200) out.push(mk(ema(cl, 200), "#a78bfa", "EMA 200"));
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
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Marktdaten</p>
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
          placeholder={market === "crypto" ? "z. B. Bitcoin oder BTCUSDT" : "z. B. Apple oder AAPL"}
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

        <div className="flex items-center gap-3 text-xs text-dim">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={indicators.sma2050}
              onChange={(e) => setIndicators((v) => ({ ...v, sma2050: e.target.checked }))}
              className="accent-[#2dd4bf]" />
            SMA 20/50
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={indicators.ema200}
              onChange={(e) => setIndicators((v) => ({ ...v, ema200: e.target.checked }))}
              className="accent-[#2dd4bf]" />
            EMA 200
          </label>
        </div>

        {/* Drawing toolbar */}
        <div className="flex items-center gap-1 sm:ml-auto">
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
              <button key={c} onClick={() => setDrawColor(c)} title="Zeichenfarbe"
                className={cn("w-5 h-5 sm:w-4 sm:h-4 rounded-full border", drawColor === c ? "border-white" : "border-transparent")}
                style={{ background: c }} />
            ))}
          </div>
        </div>
      </div>

      {stats && (
        <div className="flex flex-wrap gap-x-5 sm:gap-x-8 gap-y-2 mb-4 text-xs sm:text-sm font-mono">
          <div><span className="text-dim mr-2">Kurs</span>{fmtPrice(stats.price)}</div>
          <div>
            <span className="text-dim mr-2">Zeitraum</span>
            <span className={stats.changePct >= 0 ? "text-up" : "text-down"}>{fmtPct(stats.changePct)}</span>
          </div>
          <div><span className="text-dim mr-2">Hoch</span>{fmtPrice(stats.high)}</div>
          <div><span className="text-dim mr-2">Tief</span>{fmtPrice(stats.low)}</div>
        </div>
      )}

      {activeTool && activeTool !== "clear" && (
        <p className="text-[11px] text-accent mb-2">
          Zeichnen aktiv: {DRAW_TOOLS.find((t) => t.id === activeTool)?.label} — in den Chart klicken. Esc zum Abbrechen.
        </p>
      )}

      <div className="rounded-xl border border-line lg-glass p-3">
        {error ? (
          <div className="h-96 flex items-center justify-center text-sm text-down px-6 text-center">{error}</div>
        ) : loading && !candles ? (
          <div className="h-96 flex items-center justify-center text-sm text-dim">Lade Daten…</div>
        ) : candles ? (
          <CandleChart
            candles={candles}
            chartType={chartType}
            overlays={overlays}
            height={chartHeight()}
            onNeedOlder={loadOlder}
          >
            {({ chart, series, containerRef }) => (
              <ChartDrawLayer
                chart={chart}
                series={series}
                containerRef={containerRef}
                chartKey={chartKey}
                activeTool={activeTool}
                color={drawColor}
                onToolConsumed={() => setActiveTool(null)}
              />
            )}
          </CandleChart>
        ) : null}
      </div>
    </div>
  );
}
