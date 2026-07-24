import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Plus, X } from "lucide-react";
import EquityChart from "@/components/EquityChart";
import SymbolSearch from "@/components/SymbolSearch";
import { MARKETS } from "@/lib/data";
import {
  fetchMonthlySeries,
  fetchDividends,
  rebase,
  simulateDCA,
  simulateDividendGrowth,
} from "@/lib/compare";
import { cn, fmtNum, fmtPct } from "@/lib/utils";

const COLORS = ["#2dd4bf", "#38bdf8", "#f59e0b", "#f472b6", "#a78bfa", "#64748b"];

const TABS = [
  { id: "perf", label: "Performance" },
  { id: "dca", label: "Savings plan (DCA)" },
  { id: "div", label: "Dividends" },
];

const PERF_RANGES = [
  { id: "1y", label: "1Y", years: 1 },
  { id: "5y", label: "5Y", years: 5 },
  { id: "10y", label: "10Y", years: 10 },
  { id: "max", label: "Max", years: null },
];

const DIV_WINDOWS = [
  { id: "5y", label: "5Y", years: 5 },
  { id: "10y", label: "10Y", years: 10 },
  { id: "max", label: "Max", years: null },
];

const DEFAULT_SYMBOL = { crypto: "BTCUSDT", stock: "SPY" };
const YEAR_SECONDS = 365.25 * 86400;

// ── Module-Cache: überlebt Tab-Wechsel und Remounts, verhindert Doppel-Fetches.
const seriesCache = new Map(); // "market:SYMBOL" → Promise<[{time, close}]>
const divCache = new Map(); // "SYMBOL" → Promise<[{time, amount}]>

function getSeries(market, symbol) {
  const key = `${market}:${symbol.toUpperCase()}`;
  if (!seriesCache.has(key)) {
    const p = fetchMonthlySeries(market, symbol).catch((e) => {
      seriesCache.delete(key); // fehlgeschlagene Abrufe nicht cachen
      throw e;
    });
    seriesCache.set(key, p);
  }
  return seriesCache.get(key);
}

function getDividends(symbol) {
  const key = symbol.toUpperCase();
  if (!divCache.has(key)) {
    const p = fetchDividends(symbol).catch((e) => {
      divCache.delete(key);
      throw e;
    });
    divCache.set(key, p);
  }
  return divCache.get(key);
}

function filterYears(series, years) {
  if (!years) return series;
  const cutoff = Date.now() / 1000 - years * YEAR_SECONDS;
  return series.filter((p) => p.time >= cutoff);
}

// ── Kleine UI-Bausteine ──────────────────────────────────────────────────────

function MetricCard({ label, value, tone = "text-text" }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3">
      <p className="text-[11px] text-dim mb-1">{label}</p>
      <p className={cn("font-mono font-semibold", tone)}>{value}</p>
    </div>
  );
}

function ErrorBox({ children }) {
  return (
    <div className="rounded-xl border border-down/40 bg-down/10 p-3 text-sm text-down flex gap-2">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  );
}

function ChartSkeleton({ height = 320 }) {
  return (
    <div
      className="rounded-xl border border-line lg-glass animate-pulse flex items-center justify-center text-sm text-dim"
      style={{ height }}
    >
      Loading data…
    </div>
  );
}

function MarketToggle({ market, onChange }) {
  return (
    <div className="flex gap-1">
      {MARKETS.map((mk) => (
        <button
          key={mk.id}
          onClick={() => onChange(mk.id)}
          className={cn("chip", market === mk.id ? "chip-active" : "chip-idle")}
        >
          {mk.label}
        </button>
      ))}
    </div>
  );
}

function upDown(n) {
  return n >= 0 ? "text-up" : "text-down";
}

// ── Tab 1: Performance-Vergleich ─────────────────────────────────────────────

function PerformanceTab({ active }) {
  const [entries, setEntries] = useState([
    { id: 1, market: "stock", symbol: "SPY" },
    { id: 2, market: "crypto", symbol: "BTCUSDT" },
  ]);
  const idRef = useRef(3);
  const [range, setRange] = useState("max");
  const [loaded, setLoaded] = useState({}); // key → series
  const [errors, setErrors] = useState({}); // key → Meldung
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const nextData = {};
      const nextErrors = {};
      await Promise.all(
        entries.map(async (e) => {
          const key = `${e.market}:${e.symbol}`;
          try {
            nextData[key] = await getSeries(e.market, e.symbol);
          } catch (err) {
            nextErrors[key] = err.message;
          }
        })
      );
      if (cancelled) return;
      setLoaded(nextData);
      setErrors(nextErrors);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [active, entries]);

  const years = PERF_RANGES.find((r) => r.id === range)?.years ?? null;

  const rows = useMemo(
    () =>
      entries.map((e, i) => {
        const key = `${e.market}:${e.symbol}`;
        const color = COLORS[i % COLORS.length];
        const series = loaded[key];
        if (!series) return { entry: e, color, error: errors[key] || null };
        const filtered = filterYears(series, years);
        if (filtered.length < 2) {
          return { entry: e, color, error: `Not enough history for ${e.symbol} in this period.` };
        }
        const points = rebase(filtered);
        const first = filtered[0].close;
        const last = filtered[filtered.length - 1].close;
        const span = (filtered[filtered.length - 1].time - filtered[0].time) / YEAR_SECONDS;
        let best = -Infinity;
        let worst = Infinity;
        for (let j = 1; j < filtered.length; j++) {
          const r = (filtered[j].close / filtered[j - 1].close - 1) * 100;
          if (r > best) best = r;
          if (r < worst) worst = r;
        }
        return {
          entry: e,
          color,
          points,
          stats: {
            totalPct: (last / first - 1) * 100,
            cagrPct: span > 0 ? (Math.pow(last / first, 1 / span) - 1) * 100 : 0,
            bestMonth: best,
            worstMonth: worst,
          },
        };
      }),
    [entries, loaded, errors, years]
  );

  const chartSeries = useMemo(
    () =>
      rows
        .filter((r) => r.points)
        .map((r) => ({ label: r.entry.symbol, color: r.color, points: r.points })),
    [rows]
  );

  const updateEntry = (id, patch) =>
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const switchMarket = (id, market) =>
    updateEntry(id, { market, symbol: DEFAULT_SYMBOL[market] });

  const addEntry = () =>
    setEntries((list) =>
      list.length >= 6
        ? list
        : [...list, { id: idRef.current++, market: "stock", symbol: DEFAULT_SYMBOL.stock }]
    );

  const removeEntry = (id) =>
    setEntries((list) => (list.length <= 2 ? list : list.filter((e) => e.id !== id)));

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-dim font-medium">Symbols (2–6)</p>
          <div className="flex gap-1">
            {PERF_RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRange(r.id)}
                className={cn("chip font-mono", range === r.id ? "chip-active" : "chip-idle")}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {entries.map((e, i) => (
          <div key={e.id} className="flex flex-wrap items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: COLORS[i % COLORS.length] }}
            />
            <MarketToggle market={e.market} onChange={(m) => switchMarket(e.id, m)} />
            <SymbolSearch
              market={e.market}
              value={e.symbol}
              onSelect={(s) => updateEntry(e.id, { symbol: s })}
              placeholder={e.market === "crypto" ? "e.g. BTCUSDT" : "e.g. SPY"}
              className="flex-1 min-w-[180px]"
            />
            <button
              onClick={() => removeEntry(e.id)}
              disabled={entries.length <= 2}
              title="Remove"
              className="text-dim hover:text-down disabled:opacity-30 disabled:hover:text-dim"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}

        <button
          onClick={addEntry}
          disabled={entries.length >= 6}
          className="chip chip-idle flex items-center gap-1 disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" /> Add symbol
        </button>
      </div>

      {rows
        .filter((r) => r.error)
        .map((r) => (
          <ErrorBox key={r.entry.id}>
            {r.entry.symbol}: {r.error}
          </ErrorBox>
        ))}

      {loading ? (
        <ChartSkeleton />
      ) : chartSeries.length > 0 ? (
        <div className="rounded-xl border border-line lg-glass p-3">
          <p className="text-xs text-dim px-2 pt-1 pb-2">
            Indexed to 100 at the start of the period — monthly closing prices
          </p>
          <EquityChart series={chartSeries} />
        </div>
      ) : (
        <div className="rounded-xl border border-line lg-glass h-72 flex items-center justify-center text-sm text-dim px-8 text-center">
          No series to display — check the symbols or period.
        </div>
      )}

      {!loading && rows.some((r) => r.stats) && (
        <div className="rounded-xl border border-line lg-glass overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="text-left text-dim border-b border-line">
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-4 py-2 font-medium text-right">Total return</th>
                  <th className="px-4 py-2 font-medium text-right">CAGR</th>
                  <th className="px-4 py-2 font-medium text-right">Best month</th>
                  <th className="px-4 py-2 font-medium text-right">Worst month</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((r) => r.stats)
                  .map((r) => (
                    <tr key={r.entry.id} className="border-b border-line/40 last:border-0">
                      <td className="px-4 py-1.5">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: r.color }}
                          />
                          {r.entry.symbol}
                        </span>
                      </td>
                      <td className={cn("px-4 py-1.5 text-right", upDown(r.stats.totalPct))}>
                        {fmtPct(r.stats.totalPct)}
                      </td>
                      <td className={cn("px-4 py-1.5 text-right", upDown(r.stats.cagrPct))}>
                        {fmtPct(r.stats.cagrPct)}
                      </td>
                      <td className="px-4 py-1.5 text-right text-up">{fmtPct(r.stats.bestMonth)}</td>
                      <td className="px-4 py-1.5 text-right text-down">
                        {fmtPct(r.stats.worstMonth)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab 2: Sparplan (DCA) ────────────────────────────────────────────────────

function DcaTab({ active }) {
  const [market, setMarket] = useState("stock");
  const [symbol, setSymbol] = useState("SPY");
  const [amount, setAmount] = useState(200);
  const [startYear, setStartYear] = useState(null);
  const [series, setSeries] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active || !symbol) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSeries(market, symbol)
      .then((s) => {
        if (cancelled) return;
        setSeries(s);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e.message);
        setSeries(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, market, symbol]);

  const switchMarket = (m) => {
    setMarket(m);
    setSymbol(DEFAULT_SYMBOL[m]);
    setStartYear(null);
  };

  const yearOptions = useMemo(() => {
    if (!series) return [];
    const ys = [...new Set(series.map((p) => new Date(p.time * 1000).getUTCFullYear()))];
    return ys.length > 1 ? ys.slice(0, -1) : ys; // laufendes Jahr taugt nicht als Start
  }, [series]);

  const effStartYear = startYear ?? yearOptions[0] ?? null;

  const result = useMemo(() => {
    if (!series || !effStartYear || !(amount > 0)) return null;
    const from = Date.UTC(effStartYear, 0, 1) / 1000;
    const filtered = series.filter((p) => p.time >= from);
    if (filtered.length < 2) return null;
    return simulateDCA(filtered, amount);
  }, [series, effStartYear, amount]);

  const chartSeries = useMemo(() => {
    if (!result?.points?.length) return null;
    return [
      {
        label: "Invested",
        color: "#64748b",
        points: result.points.map((p) => ({ time: p.time, value: p.invested })),
      },
      {
        label: "Portfolio value",
        color: "#2dd4bf",
        points: result.points.map((p) => ({ time: p.time, value: p.value })),
      },
    ];
  }, [result]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
        <p className="text-xs text-dim font-medium">Savings plan</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <MarketToggle market={market} onChange={switchMarket} />
            <SymbolSearch
              market={market}
              value={symbol}
              onSelect={(s) => {
                setSymbol(s);
                setStartYear(null);
              }}
              placeholder={market === "crypto" ? "e.g. BTCUSDT" : "e.g. SPY"}
              className="w-full sm:w-64"
            />
          </div>
          <label className="text-xs text-dim">
            Monthly amount
            <input
              type="number"
              min={1}
              value={amount}
              onChange={(e) => setAmount(+e.target.value || 0)}
              className="input-base w-full mt-1 font-mono"
            />
          </label>
          <label className="text-xs text-dim">
            Start year
            <select
              value={effStartYear ?? ""}
              onChange={(e) => setStartYear(+e.target.value)}
              disabled={!yearOptions.length}
              className="input-base w-full mt-1 font-mono"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {loading ? (
        <ChartSkeleton />
      ) : result ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
            <MetricCard label="Total invested" value={fmtNum(result.totalInvested, 0)} />
            <MetricCard
              label="Final value"
              value={fmtNum(result.finalValue, 0)}
              tone={upDown(result.finalValue - result.totalInvested)}
            />
            <MetricCard
              label="Total return"
              value={fmtPct(result.totalReturnPct)}
              tone={upDown(result.totalReturnPct)}
            />
            <MetricCard
              label="CAGR"
              value={fmtPct(result.cagrPct)}
              tone={upDown(result.cagrPct)}
            />
            <MetricCard
              label={market === "crypto" ? "Coins" : "Shares"}
              value={fmtNum(result.shares, 4)}
            />
          </div>

          <div className="rounded-xl border border-line lg-glass p-3">
            <p className="text-xs text-dim px-2 pt-1 pb-2">
              <span className="text-text/70">Invested</span> vs.{" "}
              <span className="text-accent">Portfolio value</span> — buying at each month's close
            </p>
            <EquityChart series={chartSeries} />
          </div>

          <p className="text-sm text-dim leading-relaxed">
            Had you invested{" "}
            <span className="text-text font-mono">{fmtNum(amount, 0)}</span> monthly in{" "}
            <span className="text-accent font-mono">{symbol}</span> since{" "}
            <span className="text-text font-mono">{effStartYear}</span>,{" "}
            <span className="text-text font-mono">{fmtNum(result.totalInvested, 0)}</span> would be worth{" "}
            <span className={cn("font-mono", upDown(result.finalValue - result.totalInvested))}>
              {fmtNum(result.finalValue, 0)}
            </span>{" "}
            today.
          </p>
        </>
      ) : !error ? (
        <div className="rounded-xl border border-line lg-glass h-72 flex items-center justify-center text-sm text-dim px-8 text-center">
          Pick a symbol, amount, and start year — the simulation appears here.
        </div>
      ) : null}
    </div>
  );
}

// ── Tab 3: Dividends — growth of a dividend stock, three lines over time:
// invested (contributions), price-only value, and value with dividends
// reinvested. Shows the "power of dividend reinvestment" for one stock.

function DividendTab({ active }) {
  const [symbol, setSymbol] = useState("O"); // Realty Income — a classic dividend stock
  const [monthly, setMonthly] = useState(200);
  const [windowId, setWindowId] = useState("max");
  const [data, setData] = useState(null); // { series, dividends }
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [series, dividends] = await Promise.all([
          getSeries("stock", symbol),
          getDividends(symbol),
        ]);
        if (cancelled) return;
        if (!dividends.length) {
          setError(`No dividend history found for "${symbol}".`);
          setData(null);
        } else {
          setData({ series, dividends });
        }
      } catch (err) {
        if (!cancelled) { setError(err.message); setData(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [active, symbol]);

  const windowYears = DIV_WINDOWS.find((w) => w.id === windowId)?.years ?? null;

  const sim = useMemo(() => {
    if (!data) return null;
    return simulateDividendGrowth(data.series, data.dividends, { monthlyAmount: monthly, windowYears });
  }, [data, monthly, windowYears]);

  const chartSeries = useMemo(() => {
    if (!sim?.points.length) return null;
    return [
      { label: "With dividends reinvested", color: "#10b981", points: sim.points.map((p) => ({ time: p.time, value: p.totalValue })) },
      { label: "Price only", color: "#ef4444", points: sim.points.map((p) => ({ time: p.time, value: p.priceValue })) },
      { label: "Invested", color: "#94a3b8", points: sim.points.map((p) => ({ time: p.time, value: p.invested })) },
    ];
  }, [sim]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <SymbolSearch
            market="stock"
            value={symbol}
            onSelect={(s) => setSymbol(s)}
            placeholder="Dividend stock, e.g. O, KO, JNJ"
            className="flex-1 min-w-[180px]"
          />
          <label className="flex items-center gap-1.5 text-xs text-dim">
            Monthly $
            <input
              type="number" value={monthly} min={10}
              onChange={(e) => setMonthly(+e.target.value || 0)}
              className="input-base font-mono w-24 text-sm"
            />
          </label>
          <div className="flex gap-1">
            {DIV_WINDOWS.map((w) => (
              <button key={w.id} onClick={() => setWindowId(w.id)}
                className={cn("chip font-mono", windowId === w.id ? "chip-active" : "chip-idle")}>
                {w.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      {loading ? (
        <ChartSkeleton height={300} />
      ) : sim?.points.length ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard label="Invested" value={`$${fmtNum(sim.invested, 0)}`} />
            <MetricCard label="Price only" value={`$${fmtNum(sim.priceValue, 0)}`} tone="text-down" />
            <MetricCard label="With dividends" value={`$${fmtNum(sim.totalValue, 0)}`} tone="text-up" />
            <MetricCard label="Dividend boost" value={fmtPct(sim.dividendBoostPct)} tone="text-accent" />
          </div>

          <div className="rounded-xl border border-line lg-glass p-3">
            <p className="text-xs text-dim px-2 pt-1 pb-2">
              <span className="text-up">With dividends reinvested</span> vs{" "}
              <span className="text-down">price only</span> vs{" "}
              <span className="text-text/70">invested</span> — {symbol}, ${fmtNum(monthly, 0)}/month
            </p>
            <EquityChart series={chartSeries} height={320} />
          </div>

          <p className="text-xs text-dim">
            Reinvesting the dividends grew your position by{" "}
            <span className="text-accent font-semibold">{fmtPct(sim.dividendBoostPct)}</span>{" "}
            more than price appreciation alone. Simulation with fractional shares; taxes and fees ignored.
            Crypto pays no dividends — stocks/ETFs only.
          </p>
        </>
      ) : (
        <div className="rounded-xl border border-line lg-glass h-72 flex items-center justify-center text-sm text-dim px-8 text-center">
          Pick a dividend stock — the growth comparison appears here.
        </div>
      )}
    </div>
  );
}

// ── Seite ────────────────────────────────────────────────────────────────────

export default function Compare() {
  const [tab, setTab] = useState("perf");

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Analysis</p>
      <h1 className="text-2xl font-bold mb-6">Compare</h1>

      <div className="flex flex-wrap gap-1 mb-6">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn("chip", tab === t.id ? "chip-active" : "chip-idle")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Alle Tabs bleiben gemountet: State und geladene Daten überleben den
          Wechsel; gefetcht wird erst bei erster Aktivierung (active-Prop). */}
      <div className={cn(tab !== "perf" && "hidden")}>
        <PerformanceTab active={tab === "perf"} />
      </div>
      <div className={cn(tab !== "dca" && "hidden")}>
        <DcaTab active={tab === "dca"} />
      </div>
      <div className={cn(tab !== "div" && "hidden")}>
        <DividendTab active={tab === "div"} />
      </div>
    </div>
  );
}
