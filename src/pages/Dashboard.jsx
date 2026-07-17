import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { FlaskConical, Newspaper, ArrowUpRight, LayoutDashboard, Star, Activity } from "lucide-react";
import { fetchCandles, WATCHLIST } from "@/lib/data";
import WorldClock from "@/components/WorldClock";
import WatchlistPage from "@/pages/Watchlist";
import MonitorPage from "@/pages/Monitor";
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
            spark: candles.slice(-30).map((c) => c.close),
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

// Tiny inline sparkline from the last ~30 daily closes. Theme-aware stroke.
function Sparkline({ data, up }) {
  if (!data || data.length < 2) return <span className="text-dim/40 text-xs">—</span>;
  const w = 66, h = 22, min = Math.min(...data), max = Math.max(...data), rng = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${(h - 2 - ((v - min) / rng) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="inline-block align-middle" aria-hidden="true">
      <polyline points={pts} fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"
        className={up ? "stroke-up" : "stroke-down"} />
    </svg>
  );
}

function Overview() {
  const { quotes, loading } = useWatchlistQuotes();
  const navigate = useNavigate();
  return (
    <>
      <div className="rounded-xl border border-line lg-glass overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-dim text-xs border-b border-line">
              <th className="px-4 py-3 font-medium">Symbol</th>
              <th className="px-4 py-3 font-medium hidden sm:table-cell">Market</th>
              <th className="px-4 py-3 font-medium text-right">Price</th>
              <th className="px-4 py-3 font-medium text-right">1D</th>
              <th className="px-4 py-3 font-medium text-right hidden lg:table-cell">Trend</th>
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
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {loading && !q ? <span className="text-dim">…</span> : fmtPrice(q?.price)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {loading && !q ? (
                      <span className="text-dim">…</span>
                    ) : (
                      <span className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-mono font-semibold tabular-nums",
                        q?.changePct > 0 ? "bg-up/10 text-up" : q?.changePct < 0 ? "bg-down/10 text-down" : "bg-line/50 text-dim"
                      )}>
                        {fmtPct(q?.changePct)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    <div className="flex justify-end">
                      <Sparkline data={q?.spark} up={(q?.changePct ?? 0) >= 0} />
                    </div>
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
    </>
  );
}

// Dashboard = the Markets overview hub. Overview · Watchlist · Monitor are
// tabs (?view=…); old /watchlist and /monitor routes redirect into them.
const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "watchlist", label: "Watchlist", icon: Star },
  { id: "monitor", label: "Monitor", icon: Activity },
];

export default function Dashboard() {
  const [params, setParams] = useSearchParams();
  const view = params.get("view") || "overview";
  const setView = (v) => setParams(v === "overview" ? {} : { view: v });

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Markets</p>
      <nav className="flex gap-1 mb-6 border-b border-line overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            className={cn(
              "inline-flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors",
              view === t.id ? "border-accent text-accent" : "border-transparent text-dim hover:text-text"
            )}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </nav>
      {view === "watchlist" ? <WatchlistPage /> : view === "monitor" ? <MonitorPage /> : <Overview />}
    </div>
  );
}
