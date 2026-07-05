import { useEffect, useRef } from "react";
import { createChart } from "lightweight-charts";

// Multi-line comparison chart (equity curves, benchmarks).
// series: [{ label, color, points: [{ time, value }] }]
export default function EquityChart({ series, height = 320 }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "transparent" }, textColor: "#64748b" },
      grid: {
        vertLines: { color: "#141a26" },
        horzLines: { color: "#141a26" },
      },
      rightPriceScale: { borderColor: "#1c2433" },
      timeScale: { borderColor: "#1c2433" },
      height,
      width: containerRef.current.clientWidth,
    });

    for (const s of series) {
      const line = chart.addLineSeries({
        color: s.color,
        lineWidth: 2,
        priceLineVisible: false,
        title: s.label,
      });
      line.setData(s.points);
    }
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [series, height]);

  return <div ref={containerRef} style={{ height }} className="w-full" />;
}
