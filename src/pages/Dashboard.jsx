import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FlaskConical, Newspaper, ArrowUpRight } from "lucide-react";
import { fetchCandles, WATCHLIST } from "@/lib/data";
import WorldClock from "@/components/WorldClock";
import { cn, fmtPrice, fmtPct } from "@/lib/utils";

// Last price + day-over-day change per watchlist entry.
function useWatchlistQuotes() {
  const [quotes, setQuotes] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      const results = await Promise.allSettled(
        WATCHLIST.map(async (w) => {
          const candles = await fetchCandles({ market: w.market, symbol: w.symbol, interval: "1d", range: "3mo" });
          const last = candles[candles.length - 1];
          const prev = candles[candles.length - 2];
          return {
            key: `${w.market}:${w.symbol}`,
            price: last.close,
            changePct: ((last.close - prev.close) / prev.close) * 100,
          };
        })
      );
      if (!alive) return;
      const map = {};
      for (const r of results) {
        if (r.status === "fulfilled") map[r.value.key] = r.value;
      }
      setQuotes(map);
      setLoading(false);
    };
    load();
    const id = setInterval(load, 30000); // keep dashboard quotes fresh
    return () => { alive = false; clearInterval(id); };
  }, []);

  return { quotes, loading };
}

export default function Dashboard() {
  const { quotes, loading } = useWatchlistQuotes();
  const navigate = useNavigate();

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Overview</p>
      <h1 className="text-2xl font-bold mb-8">Dashboard</h1>

      <div className="rounded-xl border border-line lg-glass overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-dim text-xs border-b border-line">
              <th className="px-4 py-3 font-medium">Symbol</th>
              <th className="px-4 py-3 font-medium hidden sm:table-cell">Market</th>
              <th className="px-4 py-3 font-medium text-right">Price</th>
              <th className="px-4 py-3 font-medium text-right">1D</th>
            </tr>
          </thead>
          <tbody>
            {WATCHLIST.map((w) => {
              const q = quotes[`${w.market}:${w.symbol}`];
              return (
                <tr
                  key={`${w.market}:${w.symbol}`}
                  onClick={() => navigate(`/charts?market=${w.market}&symbol=${w.symbol}`)}
                  className="border-b border-line/50 last:border-0 hover:bg-bg/60 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <span className="font-mono font-semibold">{w.symbol}</span>
                    <span className="text-dim ml-2 hidden md:inline">{w.name}</span>
                  </td>
                  <td className="px-4 py-3 text-dim hidden sm:table-cell">
                    {w.market === "crypto" ? "Crypto" : "Stocks"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {loading && !q ? <span className="text-dim">…</span> : fmtPrice(q?.price)}
                  </td>
                  <td className={cn("px-4 py-3 text-right font-mono", q?.changePct > 0 ? "text-up" : q?.changePct < 0 ? "text-down" : "text-dim")}>
                    {loading && !q ? "…" : fmtPct(q?.changePct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mb-8">
        <WorldClock />
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Link to="/backtest" className="group rounded-xl border border-line lg-glass p-5 hover:border-accent/40 transition-colors">
          <div className="flex items-center justify-between mb-2">
            <FlaskConical className="w-5 h-5 text-accent" />
            <ArrowUpRight className="w-4 h-4 text-dim group-hover:text-accent transition-colors" />
          </div>
          <p className="font-semibold mb-1">Backtest a strategy</p>
          <p className="text-sm text-dim">Prebuilt strategies or your own code — equity curve, Sharpe, drawdown and more.</p>
        </Link>
        <Link to="/news" className="group rounded-xl border border-line lg-glass p-5 hover:border-accent/40 transition-colors">
          <div className="flex items-center justify-between mb-2">
            <Newspaper className="w-5 h-5 text-accent" />
            <ArrowUpRight className="w-4 h-4 text-dim group-hover:text-accent transition-colors" />
          </div>
          <p className="font-semibold mb-1">Market news</p>
          <p className="text-sm text-dim">CNBC, Yahoo Finance, CoinDesk and MarketWatch — bundled in one place.</p>
        </Link>
      </div>
    </div>
  );
}
