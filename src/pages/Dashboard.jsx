import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { LayoutDashboard, Star, Activity, TrendingUp, ShieldCheck, AlertTriangle } from "lucide-react";
import { fetchCandles, WATCHLIST } from "@/lib/data";
import WorldClock from "@/components/WorldClock";
import WatchlistPage from "@/pages/Watchlist";
import MonitorPage from "@/pages/Monitor";
import { cn, fmtPrice, fmtPct } from "@/lib/utils";
import CountUp from "@/components/CountUp";
import Skeleton from "@/components/Skeleton";

const fmtUsd = (v) => (v == null ? "—" : "$" + Math.round(v).toLocaleString("en-US"));

// Last price + day-over-day change per watchlist entry.
function useWatchlistQuotes() {
  const [quotes, setQuotes] = useState({});
  const [loading, setLoading] = useState(true);

  // load() fetches every symbol and MERGES successes into the existing quotes
  // (a symbol that fails this cycle keeps its last good value instead of blanking
  // out). It never flips `loading` on, so the 30s poll doesn't flash skeletons;
  // only the initial state and an explicit reload() show the loading state.
  const load = useCallback(async () => {
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
    setQuotes((prev) => {
      const map = { ...prev };
      for (const r of results) if (r.status === "fulfilled") map[r.value.key] = r.value;
      return map;
    });
    setLoading(false);
  }, []);

  const reload = useCallback(() => { setLoading(true); load(); }, [load]);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (!document.hidden && alive) load(); };
    load();
    const id = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [load]);

  return { quotes, loading, reload };
}

// Cortex paper-portfolio + RiskGate summary (private — needs the dev token).
function useLabState() {
  const [state, setState] = useState(undefined); // undefined=loading, null=none
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        // Admin session cookie gates this server-side; a 401 (not signed in as
        // the dev account) just means the private KPIs stay hidden.
        const res = await fetch("/api/lab");
        const out = await res.json();
        if (alive) setState(res.ok ? out.state : null);
      } catch { if (alive) setState(null); }
    };
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return state;
}

// Flashes a brief up/down tint when its `value` changes between polls — the way
// a trading terminal marks a tick. Re-triggers the one-shot CSS animation by
// toggling the class with a forced reflow (React won't replay it otherwise).
function FlashCell({ value, className, children }) {
  const ref = useRef(null);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current == null || value == null || value === prev.current) { prev.current = value; return; }
    const up = value > prev.current;
    prev.current = value;
    const el = ref.current;
    if (!el) return;
    el.classList.remove("flash-up", "flash-down");
    void el.offsetWidth; // reflow so the animation restarts from 0
    el.classList.add(up ? "flash-up" : "flash-down");
  }, [value]);
  return <span ref={ref} className={className}>{children}</span>;
}

// Tiny inline sparkline from the last ~30 daily closes. Theme-aware stroke.
function Sparkline({ data, up, delay = 0 }) {
  if (!data || data.length < 2) return <span className="text-dim/40 text-xs">—</span>;
  const w = 66, h = 22, min = Math.min(...data), max = Math.max(...data), rng = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${(h - 2 - ((v - min) / rng) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="inline-block align-middle" aria-hidden="true">
      <polyline points={pts} pathLength="1" fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"
        style={{ animationDelay: `${delay}ms` }}
        className={cn("draw-in", up ? "stroke-up" : "stroke-down")} />
    </svg>
  );
}

// Responsive equity area chart from a [{t,v}] history. Theme-aware.
function AreaChart({ history, height = 200 }) {
  const vals = (history || []).map((p) => p.v).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return <div className="grid place-items-center text-sm text-dim" style={{ height }}>No equity history yet — run the paper agent.</div>;
  const W = 600, H = height, min = Math.min(...vals), max = Math.max(...vals), rng = max - min || 1;
  const X = (i) => (i / (vals.length - 1)) * W;
  const Y = (v) => H - 4 - ((v - min) / rng) * (H - 14);
  const line = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden="true">
      <defs>
        <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: "rgb(var(--c-up))", stopOpacity: 0.24 }} />
          <stop offset="100%" style={{ stopColor: "rgb(var(--c-up))", stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${line} ${W},${H}`} fill="url(#eq-fill)" className="fade-in" />
      <polyline points={line} pathLength="1" fill="none" className="stroke-up draw-in" strokeWidth="2"
        vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function KpiCard({ label, value, sub, icon: Icon, tone }) {
  return (
    <div className="rounded-xl border border-line lg-glass p-4 hover-lift">
      <p className="text-[10px] uppercase tracking-wide text-dim flex items-center gap-1.5 mb-2">
        {Icon && <Icon className="w-3 h-3 text-accent" />}{label}
      </p>
      <div className={cn("font-mono text-2xl font-bold tabular-nums leading-none", tone)}>{value}</div>
      {sub && <div className="mt-2 text-xs flex items-center gap-2">{sub}</div>}
    </div>
  );
}

function WatchlistCard() {
  const { quotes, loading, reload } = useWatchlistQuotes();
  const navigate = useNavigate();
  const failed = loading ? 0 : WATCHLIST.filter((w) => !quotes[`${w.market}:${w.symbol}`]).length;
  return (
    <div className="rounded-xl border border-line lg-glass overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <span className="text-sm font-semibold">Watchlist</span>
        {failed > 0 ? (
          <button onClick={reload} className="flex items-center gap-1 text-[11px] text-down hover:underline" title="Some quotes failed to load">
            <AlertTriangle className="w-3 h-3" /> {failed} failed · retry
          </button>
        ) : (
          <span className="text-xs text-dim">live</span>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-dim text-[10px] uppercase tracking-wide border-b border-line">
            <th className="px-4 py-2.5 font-medium">Symbol</th>
            <th className="px-4 py-2.5 font-medium text-right">Last</th>
            <th className="px-4 py-2.5 font-medium text-right">1D</th>
            <th className="px-4 py-2.5 font-medium text-right hidden sm:table-cell">Trend</th>
          </tr>
        </thead>
        <tbody>
          {WATCHLIST.map((w, i) => {
            const q = quotes[`${w.market}:${w.symbol}`];
            return (
              <tr key={`${w.market}:${w.symbol}`}
                role="button" tabIndex={0}
                aria-label={`Open ${w.symbol} chart`}
                onClick={() => navigate(`/charts?market=${w.market}&symbol=${w.symbol}`)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(`/charts?market=${w.market}&symbol=${w.symbol}`); } }}
                className="border-b border-line/50 last:border-0 hover:bg-bg/60 cursor-pointer transition-colors focus:outline-none focus-visible:bg-accent/5">
                <td className="px-4 py-3">
                  <span className="font-mono font-semibold">{w.symbol}</span>
                  <span className="text-dim ml-2 hidden md:inline text-xs">{w.name}</span>
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">
                  {loading && !q ? <Skeleton className="h-4 w-16 ml-auto" />
                    : q ? <FlashCell value={q.price} className="inline-block rounded px-1 -mx-1">{fmtPrice(q.price)}</FlashCell>
                    : <span className="text-dim/40" title="Failed to load">—</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  {loading && !q ? <Skeleton className="h-5 w-14 ml-auto rounded-full" />
                    : q ? (
                      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-mono font-semibold tabular-nums",
                        q.changePct > 0 ? "bg-up/10 text-up" : q.changePct < 0 ? "bg-down/10 text-down" : "bg-line/50 text-dim")}>
                        {fmtPct(q.changePct)}
                      </span>
                    )
                    : <span className="text-dim/40" title="Failed to load">—</span>}
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  <div className="flex justify-end">
                    {loading && !q ? <Skeleton className="h-4 w-16" />
                      : q ? <Sparkline data={q.spark} up={(q.changePct ?? 0) >= 0} delay={i * 90} />
                      : <span className="text-dim/40 text-xs">—</span>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Overview() {
  const lab = useLabState();
  const c = lab?.combined;
  const rg = lab?.riskgate;
  const hasPortfolio = !!c;

  return (
    <>
      {hasPortfolio && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4 stagger">
          <KpiCard
            icon={TrendingUp}
            label="Combined equity"
            value={<CountUp value={c.equity} format={(v) => "$" + Math.round(v).toLocaleString("en-US")} />}
            sub={
              <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 font-mono font-semibold tabular-nums",
                c.returnPct >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down")}>
                {c.returnPct >= 0 ? "▲" : "▼"} {fmtPct(c.returnPct)}
              </span>
            }
          />
          <KpiCard label="Paper strategies"
            value={<CountUp value={lab.strategies?.filter((s) => !s.error).length ?? 0} format={(v) => String(Math.round(v))} />}
            sub={<span className="text-dim">virtual book</span>} />
          <KpiCard label="Max drawdown" tone="text-down"
            value={rg?.activeLimits
              ? <CountUp value={rg.activeLimits.combinedDrawdownPct} format={(v) => `${v.toFixed(1)}%`} />
              : "—"}
            sub={<span className="text-dim">peak-to-trough</span>} />
          <KpiCard icon={ShieldCheck} label="RiskGate"
            value={<span className={cn("inline-flex items-center gap-1.5 text-sm font-semibold rounded-full px-2.5 py-1", rg?.armed ? "bg-up/10 text-up" : "bg-line/50 text-dim")}>
              <span className={cn("w-1.5 h-1.5 rounded-full", rg?.armed ? "bg-up pulse-dot" : "bg-dim")} />{rg?.armed ? "Armed" : "Idle"}</span>}
            sub={<span className="text-dim">{rg?.activeLimits?.openPositions ?? 0} / {rg?.rules?.maxSimultaneousPositions ?? "—"} open</span>} />
        </div>
      )}

      <div className={cn("grid gap-4", hasPortfolio ? "lg:grid-cols-[1.5fr_1fr]" : "grid-cols-1")}>
        {hasPortfolio && (
          <div className="rounded-xl border border-line lg-glass p-5">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-sm font-semibold">Combined equity</span>
                <span className="text-dim text-xs ml-2">{lab.strategies?.filter((s) => !s.error).length ?? 0} strategies</span>
              </div>
              {c.returnPct != null && (
                <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-mono font-semibold",
                  c.returnPct >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down")}>
                  {c.returnPct >= 0 ? "▲" : "▼"} {fmtPct(c.returnPct)}
                </span>
              )}
            </div>
            <AreaChart history={c.history} />
          </div>
        )}
        <WatchlistCard />
      </div>

      <div className="mt-6">
        <WorldClock />
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
      <div key={view} className="tab-in">
        {view === "watchlist" ? <WatchlistPage /> : view === "monitor" ? <MonitorPage /> : <Overview />}
      </div>
    </div>
  );
}
