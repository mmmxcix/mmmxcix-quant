import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { LayoutDashboard, Star, Activity, TrendingUp, ShieldCheck, RefreshCw } from "lucide-react";
import { fetchCandles, WATCHLIST } from "@/lib/data";
import { getPortfolio, getWatchlist, subscribe as subscribeStore } from "@/lib/portfolio";
import WorldClock from "@/components/WorldClock";
import WatchlistPage from "@/pages/Watchlist";
import MonitorPage from "@/pages/Monitor";
import { cn, fmtPrice, fmtPct } from "@/lib/utils";
import CountUp from "@/components/CountUp";
import Skeleton from "@/components/Skeleton";

const fmtUsd = (v) => (v == null ? "—" : "$" + Math.round(v).toLocaleString("en-US"));

// Last price + day-over-day change per watchlist entry.
function useWatchlistQuotes(list) {
  const [quotes, setQuotes] = useState({});
  const [loading, setLoading] = useState(true);
  const key = list.map((w) => `${w.market}:${w.symbol}`).join(",");

  // load() fetches every symbol and MERGES successes into the existing quotes
  // (a symbol that fails this cycle keeps its last good value instead of blanking
  // out). It never flips `loading` on, so the 30s poll doesn't flash skeletons;
  // only the initial state, a list change and an explicit reload() show it.
  const load = useCallback(async () => {
    const results = await Promise.allSettled(
      list.map(async (w) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reload = useCallback(() => { setLoading(true); load(); }, [load]);

  useEffect(() => {
    let alive = true;
    setLoading(true); // list changed (or first mount) — show skeletons once
    const tick = () => { if (!document.hidden && alive) load(); };
    load();
    const id = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [load]);

  return { quotes, loading, reload };
}

// The signed-in person's OWN watchlist (managed on the Watchlist tab), falling
// back to the curated defaults while it's empty so the card never renders bare.
function useUserWatchlist() {
  const [list, setList] = useState(getWatchlist);
  useEffect(() => subscribeStore(() => setList(getWatchlist())), []);
  return list.length ? { list, custom: true } : { list: WATCHLIST, custom: false };
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
// Hover/touch: a crosshair follows the curve and shows value + date + change
// vs the start of the visible window.
function AreaChart({ history, height = 200, fmt }) {
  const wrapRef = useRef(null);
  const [hov, setHov] = useState(null); // index into pts
  const pts = (history || []).filter((p) => Number.isFinite(p.v));
  if (pts.length < 2) return <div className="grid place-items-center text-sm text-dim" style={{ height }}>No equity history yet — run the paper agent.</div>;
  const vals = pts.map((p) => p.v);
  const W = 600, H = height, min = Math.min(...vals), max = Math.max(...vals), rng = max - min || 1;
  const X = (i) => (i / (vals.length - 1)) * W;
  const Y = (v) => H - 4 - ((v - min) / rng) * (H - 14);
  const line = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");

  const onMove = (e) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHov(Math.round(frac * (pts.length - 1)));
  };
  const h = hov != null ? pts[hov] : null;
  const hx = hov != null ? (hov / (pts.length - 1)) * 100 : 0;
  const hy = h ? (Y(h.v) / H) * 100 : 0;
  const hChg = h && vals[0] > 0 ? ((h.v / vals[0]) - 1) * 100 : null;
  const format = fmt || ((v) => v.toFixed(2));

  return (
    <div ref={wrapRef} className="relative touch-pan-y" onPointerMove={onMove} onPointerLeave={() => setHov(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full block" style={{ height }} aria-hidden="true">
        <defs>
          <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "rgb(var(--c-up))", stopOpacity: 0.24 }} />
            <stop offset="100%" style={{ stopColor: "rgb(var(--c-up))", stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <polygon points={`0,${H} ${line} ${W},${H}`} fill="url(#eq-fill)" className="fade-in" />
        {/* No draw-in here: dash-based drawing + non-scaling-stroke on a
            stretched (preserveAspectRatio="none") svg makes Chromium measure
            the dash in screen space — the line visibly stops partway. */}
        <polyline points={line} fill="none" className="stroke-up fade-in" strokeWidth="2"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      {h && (
        <>
          <div className="absolute top-0 bottom-0 w-px bg-text/20 pointer-events-none" style={{ left: `${hx}%` }} />
          <div className="absolute w-2.5 h-2.5 rounded-full bg-up border-2 border-bg pointer-events-none -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${hx}%`, top: `${hy}%` }} />
          <div className="absolute top-1 pointer-events-none rounded-lg border border-line bg-bg/95 backdrop-blur px-2.5 py-1.5 text-[11px] font-mono whitespace-nowrap shadow-sm"
            style={{ left: `${hx}%`, transform: hx > 55 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
            <span className="text-text font-semibold">{format(h.v)}</span>
            {hChg != null && (
              <span className={cn("ml-2 font-semibold", hChg >= 0 ? "text-up" : "text-down")}>
                {hChg >= 0 ? "+" : ""}{hChg.toFixed(2)}%
              </span>
            )}
            <span className="text-dim ml-2">
              {new Date(h.t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
            </span>
          </div>
        </>
      )}
    </div>
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
  const { list, custom } = useUserWatchlist();
  const { quotes, loading, reload } = useWatchlistQuotes(list);
  const navigate = useNavigate();
  const failed = loading ? 0 : list.filter((w) => !quotes[`${w.market}:${w.symbol}`]).length;
  return (
    <div className="rounded-xl border border-line lg-glass overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <span className="text-sm font-semibold">
          Watchlist
          {!custom && <span className="ml-2 text-[10px] font-normal text-dim">defaults — add your own in the Watchlist tab</span>}
        </span>
        {failed > 0 ? (
          <button onClick={reload} className="flex items-center gap-1 text-[11px] text-dim hover:text-fg hover:underline" title={`${failed} quote${failed > 1 ? "s" : ""} didn't load — tap to retry`}>
            <RefreshCw className="w-3 h-3" /> {failed} pending · retry
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
          {list.map((w, i) => {
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
                      : q ? <Sparkline data={q.spark} up={(q.spark?.at(-1) ?? 0) >= (q.spark?.[0] ?? 0)} delay={i * 90} />
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

// Align multiple daily candle series on their common timeline and combine them
// (portfolio = Σ shares × close; watchlist = equal-weight index, start 100).
// value(close, t) also receives the bar time so portfolio positions can respect
// their buy/sell window (0 before the buy, frozen proceeds after the sale).
function combineSeries(entries) {
  if (!entries.length) return [];
  const start = Math.max(...entries.map((e) => e.candles[0].time));
  const times = [...new Set(entries.flatMap((e) => e.candles.map((c) => c.time)))]
    .filter((t) => t >= start)
    .sort((a, b) => a - b);
  const idx = entries.map(() => 0);
  const out = [];
  for (const t of times) {
    let v = 0, ok = true;
    entries.forEach((e, i) => {
      const cs = e.candles;
      while (idx[i] + 1 < cs.length && cs[idx[i] + 1].time <= t) idx[i]++;
      if (cs[idx[i]].time > t) { ok = false; return; }
      v += e.value(cs[idx[i]].close, t); // forward-fill: last known close
    });
    if (ok) out.push({ t: t * 1000, v });
  }
  return out;
}

const EQUITY_SRC_KEY = "quant_equity_src";
const EQUITY_RANGE_KEY = "quant_equity_range";

// Selectable window for the equity chart. `fetch` is the candle range pulled
// for portfolio/watchlist; paper history is filtered client-side by `days`.
const EQ_RANGES = [
  { id: "1w", label: "1W", days: 7, fetch: "5d" },
  { id: "1mo", label: "1M", days: 30, fetch: "1mo" },
  { id: "3mo", label: "3M", days: 90, fetch: "3mo" },
  { id: "1y", label: "1Y", days: 365, fetch: "1y" },
  { id: "max", label: "Max", days: Infinity, fetch: "5y" },
];

// The big equity chart, switchable between the three books you actually have:
// the Cortex PAPER book (when the agent reports), your simulated PORTFOLIO,
// and a WATCHLIST index. The choice sticks (localStorage).
function EquityCard({ lab }) {
  const c = lab?.combined;
  const { list } = useUserWatchlist();
  const [positions, setPositions] = useState(getPortfolio);
  useEffect(() => subscribeStore(() => setPositions(getPortfolio())), []);

  // Argus (the 24/7 day-trader) account balance + its curve. GET /api/argus is
  // public; there's no equity time-series stored, so we rebuild it from the closed-
  // trade ledger (cumulative realised P&L from the 10k start) and tip it with the
  // current mark-to-market balance.
  const [argus, setArgus] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/argus").then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive) setArgus(j?.ok ? j : null); }).catch(() => {});
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  const argusHistory = useMemo(() => {
    if (!argus) return null;
    const led = [...(argus.ledger || [])].filter((t) => Number.isFinite(t.pnl) && t.exitAt).sort((a, b) => a.exitAt - b.exitAt);
    const START = 10000;
    let eq = START;
    const h = [{ t: (led[0]?.exitAt ?? Date.now()) - 86_400_000, v: START }];
    for (const t of led) { eq += t.pnl; h.push({ t: t.exitAt, v: eq }); }
    const mark = argus.state?.markEquity;
    if (Number.isFinite(mark)) h.push({ t: argus.state?.at ?? Date.now(), v: mark });
    return h;
  }, [argus]);
  const hasArgus = argusHistory && argusHistory.length >= 2;

  const sources = useMemo(() => [
    ...(c ? [{ id: "paper", label: "Paper" }] : []),
    ...(hasArgus ? [{ id: "argus", label: "Argus" }] : []),
    { id: "portfolio", label: "Portfolio" },
    { id: "watchlist", label: "Watchlist" },
  ], [c, hasArgus]);

  const [src, setSrc] = useState(() => {
    try { return localStorage.getItem(EQUITY_SRC_KEY) || ""; } catch { return ""; }
  });
  const active = sources.some((s) => s.id === src) ? src : (c ? "paper" : positions.length ? "portfolio" : "watchlist");
  const choose = (id) => {
    setSrc(id);
    try { localStorage.setItem(EQUITY_SRC_KEY, id); } catch { /* private mode */ }
  };

  // Window length (1W…Max) — sticks like the source choice.
  const [rangeId, setRangeId] = useState(() => {
    try { return localStorage.getItem(EQUITY_RANGE_KEY) || "3mo"; } catch { return "3mo"; }
  });
  const range = EQ_RANGES.find((r) => r.id === rangeId) || EQ_RANGES[2];
  const chooseRange = (id) => {
    setRangeId(id);
    try { localStorage.setItem(EQUITY_RANGE_KEY, id); } catch { /* private mode */ }
  };

  // Portfolio/watchlist curves are built client-side from daily candles over
  // the selected window. Portfolio positions honor buy/sell dates: nothing
  // before the buy, live value while held, frozen sale proceeds after selling.
  const listKey = list.map((w) => `${w.market}:${w.symbol}`).join(",");
  const [curve, setCurve] = useState({ data: null, loading: false, empty: "" });
  useEffect(() => {
    if (active === "paper") { setCurve({ data: null, loading: false, empty: "" }); return; }
    const entries = active === "portfolio"
      ? positions.map((p) => {
          const buySec = Math.floor((p.buyDate ?? p.addedAt ?? 0) / 1000);
          const sellSec = p.sellPrice > 0 && p.sellDate ? Math.floor(p.sellDate / 1000) : null;
          return { market: p.market, symbol: p.symbol, mk: (candles) => ({ candles, value: (close, t) => {
            if (t < buySec) return 0;
            if (sellSec != null && t >= sellSec) return p.shares * p.sellPrice;
            return p.shares * close;
          } }) };
        })
      : list.map((w) => ({ market: w.market, symbol: w.symbol, mk: (candles) => ({ candles, value: (close) => (close / candles[0].close) * (100 / list.length) }) }));
    if (!entries.length) {
      setCurve({ data: [], loading: false, empty: active === "portfolio" ? "No positions yet — add some on the Portfolio page." : "Watchlist is empty." });
      return;
    }
    let alive = true;
    setCurve({ data: null, loading: true, empty: "" });
    Promise.allSettled(entries.map(async (e) => {
      const cs = await fetchCandles({ market: e.market, symbol: e.symbol, interval: "1d", range: range.fetch });
      if (!cs || cs.length < 2) throw new Error("no data");
      return e.mk(cs);
    })).then((rs) => {
      if (!alive) return;
      const ok = rs.filter((r) => r.status === "fulfilled").map((r) => r.value);
      setCurve({ data: combineSeries(ok), loading: false, empty: ok.length ? "" : "Couldn't load price data." });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, positions, listKey, rangeId]);

  // Paper history is filtered client-side to the selected window.
  const paperHistory = useMemo(() => {
    const hist = c?.history || [];
    if (!Number.isFinite(range.days)) return hist;
    const cutoff = Date.now() - range.days * 86400_000;
    return hist.filter((p) => p.t >= cutoff);
  }, [c, range.days]);

  const argusWindowed = useMemo(() => {
    const hist = argusHistory || [];
    if (!Number.isFinite(range.days)) return hist;
    const cutoff = Date.now() - range.days * 86400_000;
    const f = hist.filter((p) => p.t >= cutoff);
    return f.length >= 2 ? f : hist; // too short a window → show the whole curve
  }, [argusHistory, range.days]);

  const history = active === "paper" ? paperHistory : active === "argus" ? argusWindowed : (curve.data || []);
  // Change over the VISIBLE window, so the badge always matches the chart.
  const chgPct = history.length >= 2 && history[0].v > 0
    ? ((history[history.length - 1].v / history[0].v) - 1) * 100
    : (active === "paper" ? c?.returnPct : null);

  const TITLES = {
    paper: ["Paper equity", `${lab?.strategies?.filter((s) => !s.error).length ?? 0} strategies · virtual book`],
    argus: ["Argus equity", `24/7 day-trader · virtual account${argus?.ledger?.length ? ` · ${argus.ledger.length} closed` : ""}`],
    portfolio: ["Portfolio value", `your simulated holdings · ${range.label}`],
    watchlist: ["Watchlist index", `equal-weight · ${range.label} · start = 100`],
  };
  const [title, sub] = TITLES[active];
  const fmtHover = active === "watchlist"
    ? (v) => v.toFixed(2)
    : (v) => (Math.abs(v) >= 1000 ? "$" + Math.round(v).toLocaleString("en-US") : "$" + v.toFixed(2));

  return (
    <div className="rounded-xl border border-line lg-glass p-5">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="min-w-0">
          <span className="text-sm font-semibold">{title}</span>
          <span className="text-dim text-xs ml-2">{sub}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {chgPct != null && Number.isFinite(chgPct) && (
            <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-mono font-semibold",
              chgPct >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down")}>
              {chgPct >= 0 ? "▲" : "▼"} {fmtPct(chgPct)}
            </span>
          )}
          <div className="flex gap-1">
            {sources.map((s) => (
              <button key={s.id} onClick={() => choose(s.id)}
                className={cn("chip !text-[10px] !py-0.5", active === s.id ? "chip-active" : "chip-idle")}>
                {s.label}
              </button>
            ))}
          </div>
          <span className="w-px h-4 bg-line" />
          <div className="flex gap-1">
            {EQ_RANGES.map((r) => (
              <button key={r.id} onClick={() => chooseRange(r.id)}
                className={cn("chip !text-[10px] !py-0.5 font-mono", rangeId === r.id ? "chip-active" : "chip-idle")}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {active !== "paper" && curve.loading ? (
        <Skeleton className="h-[200px] w-full rounded-lg" />
      ) : active !== "paper" && curve.empty ? (
        <div className="grid place-items-center text-sm text-dim" style={{ height: 200 }}>{curve.empty}</div>
      ) : (
        <AreaChart key={`${active}:${rangeId}`} history={history} fmt={fmtHover} />
      )}
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

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr] [&>*]:min-w-0">
        <EquityCard lab={lab} />
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
