import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import CandleChart from "@/components/CandleChart";
import { fetchCandles, MARKETS, INTERVALS, RANGES } from "@/lib/data";
import { sma, closes } from "@/lib/indicators";
import { cn, fmtPrice, fmtPct } from "@/lib/utils";

const DEFAULT_SYMBOL = { crypto: "BTCUSDT", stock: "AAPL" };

export default function Charts() {
  const [params, setParams] = useSearchParams();
  const market = params.get("market") || "crypto";
  const symbol = params.get("symbol") || DEFAULT_SYMBOL[market];

  const [input, setInput] = useState(symbol);
  const [interval, setIntervalId] = useState("1d");
  const [range, setRange] = useState("1y");
  const [showSma, setShowSma] = useState(true);
  const [candles, setCandles] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setInput(symbol); }, [symbol]);

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

  const overlays = useMemo(() => {
    if (!candles || !showSma) return [];
    const cl = closes(candles);
    const mk = (values, color, label) => ({
      label,
      color,
      points: values
        .map((v, i) => (v === null ? null : { time: candles[i].time, value: v }))
        .filter(Boolean),
    });
    return [mk(sma(cl, 20), "#38bdf8", "SMA 20"), mk(sma(cl, 50), "#f59e0b", "SMA 50")];
  }, [candles, showSma]);

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

  const submit = (e) => {
    e.preventDefault();
    const s = input.trim().toUpperCase();
    if (s) setParams({ market, symbol: s });
  };

  const switchMarket = (m) => {
    if (m !== market) setParams({ market: m, symbol: DEFAULT_SYMBOL[m] });
  };

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Marktdaten</p>
      <h1 className="text-2xl font-bold mb-6">Charts</h1>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex gap-1">
          {MARKETS.map((m) => (
            <button key={m.id} onClick={() => switchMarket(m.id)}
              className={cn("chip", market === m.id ? "chip-active" : "chip-idle")}>
              {m.label}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={market === "crypto" ? "z. B. BTCUSDT" : "z. B. AAPL, SPY, ^GSPC"}
            className="input-base font-mono w-44"
          />
          <button type="submit" className="btn-ghost" aria-label="Laden"><Search className="w-4 h-4" /></button>
        </form>
        <label className="flex items-center gap-2 text-xs text-dim cursor-pointer select-none ml-auto">
          <input type="checkbox" checked={showSma} onChange={(e) => setShowSma(e.target.checked)} className="accent-[#2dd4bf]" />
          SMA 20/50
        </label>
      </div>

      <div className="flex flex-wrap gap-1 mb-4">
        {INTERVALS.filter((i) => i.markets.includes(market)).map((i) => (
          <button key={i.id} onClick={() => setIntervalId(i.id)}
            className={cn("chip font-mono", interval === i.id ? "chip-active" : "chip-idle")}>
            {i.label}
          </button>
        ))}
        <span className="w-3" />
        {RANGES.map((r) => (
          <button key={r.id} onClick={() => setRange(r.id)}
            className={cn("chip font-mono", range === r.id ? "chip-active" : "chip-idle")}>
            {r.label}
          </button>
        ))}
      </div>

      {stats && (
        <div className="flex flex-wrap gap-x-8 gap-y-2 mb-4 text-sm font-mono">
          <div><span className="text-dim mr-2">Kurs</span>{fmtPrice(stats.price)}</div>
          <div>
            <span className="text-dim mr-2">Zeitraum</span>
            <span className={stats.changePct >= 0 ? "text-up" : "text-down"}>{fmtPct(stats.changePct)}</span>
          </div>
          <div><span className="text-dim mr-2">Hoch</span>{fmtPrice(stats.high)}</div>
          <div><span className="text-dim mr-2">Tief</span>{fmtPrice(stats.low)}</div>
        </div>
      )}

      <div className="rounded-xl border border-line bg-surface p-3">
        {error ? (
          <div className="h-96 flex items-center justify-center text-sm text-down px-6 text-center">{error}</div>
        ) : loading && !candles ? (
          <div className="h-96 flex items-center justify-center text-sm text-dim">Lade Daten…</div>
        ) : candles ? (
          <CandleChart candles={candles} overlays={overlays} />
        ) : null}
      </div>
    </div>
  );
}
