import { useEffect, useRef } from "react";
import { createChart } from "lightweight-charts";
import { rsi, macd, closes } from "@/lib/indicators";
import { vizColor } from "@/lib/vizColors";

// A compact oscillator pane (RSI or MACD) rendered as its own lightweight-charts
// instance below the main price chart and time-synced to it. lightweight-charts
// v4 has no native multi-pane support, so we stack charts and mirror the main
// chart's visible logical range one-directionally (main drives, pane follows).
//
// Alignment: both charts use the same fixed price-scale width so their time
// axes line up. The pane hides its own time axis (the main chart shows it).
const PANE_THEME = {
  layout: { background: { color: "transparent" }, textColor: "#64748b" },
  grid: { vertLines: { color: "#141a26" }, horzLines: { color: "#141a26" } },
  rightPriceScale: { borderColor: "#1c2433", minimumWidth: 64 },
  timeScale: { visible: false, borderColor: "#1c2433" },
  handleScroll: false,
  handleScale: false,
  crosshair: { horzLine: { visible: false }, vertLine: { labelVisible: false } },
};

export default function IndicatorPane({ candles, type, mainChart, height = 130 }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});

  // Create the pane chart once per type.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      ...PANE_THEME,
      height,
      width: containerRef.current.clientWidth,
    });
    chartRef.current = chart;

    if (type === "rsi") {
      seriesRef.current.line = chart.addLineSeries({ color: vizColor("purple"), lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
      // 70/30 guide lines.
      const guide = (v, c) => {
        const s = chart.addLineSeries({ color: c, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        return s;
      };
      seriesRef.current.over = guide(70, "#ef444455");
      seriesRef.current.under = guide(30, "#10b98155");
      chart.priceScale("right").applyOptions({ autoScale: false, scaleMargins: { top: 0.1, bottom: 0.1 } });
    } else {
      // MACD: histogram + macd line + signal line.
      seriesRef.current.hist = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      seriesRef.current.macd = chart.addLineSeries({ color: vizColor("blue"), lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
      seriesRef.current.signal = chart.addLineSeries({ color: vizColor("amber"), lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    }

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = {};
    };
  }, [type, height]);

  // Feed indicator data.
  useEffect(() => {
    const s = seriesRef.current;
    if (!chartRef.current || !candles?.length) return;
    const cl = closes(candles);

    if (type === "rsi") {
      const r = rsi(cl, 14);
      s.line.setData(r.map((v, i) => (v === null ? null : { time: candles[i].time, value: v })).filter(Boolean));
      const first = candles[0].time, last = candles[candles.length - 1].time;
      s.over.setData([{ time: first, value: 70 }, { time: last, value: 70 }]);
      s.under.setData([{ time: first, value: 30 }, { time: last, value: 30 }]);
      chartRef.current.priceScale("right").applyOptions({ autoScale: false });
      s.line.applyOptions({});
      // Pin RSI scale to 0..100.
      try { s.line.priceScale().applyOptions({ autoScale: false, minValue: 0, maxValue: 100 }); } catch { /* older api */ }
    } else {
      const m = macd(cl, 12, 26, 9);
      const histData = [], macdData = [], sigData = [];
      m.forEach((v, i) => {
        if (v === null) return;
        const t = candles[i].time;
        histData.push({ time: t, value: v.hist, color: v.hist >= 0 ? "#10b98188" : "#ef444488" });
        macdData.push({ time: t, value: v.macd });
        sigData.push({ time: t, value: v.signal });
      });
      s.hist.setData(histData);
      s.macd.setData(macdData);
      s.signal.setData(sigData);
    }
  }, [candles, type]);

  // Mirror the main chart's visible range (one-directional follow).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !mainChart) return;
    const handler = (range) => {
      if (!range) return;
      try { chart.timeScale().setVisibleLogicalRange(range); } catch { /* torn down */ }
    };
    mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    // Initial sync.
    const cur = mainChart.timeScale().getVisibleLogicalRange();
    if (cur) handler(cur);
    return () => {
      try { mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler); } catch { /* ignore */ }
    };
  }, [mainChart, candles]);

  return (
    <div className="mt-2">
      <p className="text-[10px] uppercase tracking-widest text-dim mb-1 px-1">
        {type === "rsi" ? "RSI (14)" : "MACD (12, 26, 9)"}
      </p>
      <div ref={containerRef} style={{ height }} className="w-full" />
    </div>
  );
}
