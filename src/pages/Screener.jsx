import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, ArrowUpDown } from "lucide-react";
import { scanCrypto, scanStocks, applyFilters } from "@/lib/screener";
import { MARKETS } from "@/lib/data";
import { cn, fmtPrice, fmtPct, fmtNum } from "@/lib/utils";

const RSI_OPTS = [
  { id: "any", label: "RSI: all" },
  { id: "oversold", label: "Oversold (<30)" },
  { id: "overbought", label: "Overbought (>70)" },
];
const TREND_OPTS = [
  { id: "any", label: "Trend: all" },
  { id: "above50", label: "Above SMA 50" },
  { id: "below50", label: "Below SMA 50" },
  { id: "above200", label: "Above SMA 200" },
  { id: "below200", label: "Below SMA 200" },
];

// Compact volume: 1.2 B / 3.4 M / 5.6 K
function fmtVol(v) {
  if (v == null || Number.isNaN(v)) return "–";
  if (v >= 1e9) return `${fmtNum(v / 1e9, 1)} B`;
  if (v >= 1e6) return `${fmtNum(v / 1e6, 1)} M`;
  if (v >= 1e3) return `${fmtNum(v / 1e3, 1)} K`;
  return fmtNum(v, 0);
}

export default function Screener() {
  const navigate = useNavigate();
  const [market, setMarket] = useState("crypto");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [missing, setMissing] = useState(null); // symbols the scan could not reach

  const [rsiFilter, setRsiFilter] = useState("any");
  const [trendFilter, setTrendFilter] = useState("any");
  const [sectorFilter, setSectorFilter] = useState("any");
  const [minChange, setMinChange] = useState("");
  const [sort, setSort] = useState({ key: "volume", dir: "desc" });

  const load = async (m = market) => {
    setLoading(true);
    setError(null);
    try {
      const data = m === "crypto" ? await scanCrypto({ limit: 30 }) : await scanStocks();
      setRows(data);
      // A screen is a statement about a LIST. Symbols the data proxy refused
      // (usually a rate limit) used to vanish from the results with nothing
      // said, so a partial scan read exactly like a complete one.
      setMissing(data.unreachable?.length ? { syms: data.unreachable, of: data.universeSize } : null);
    } catch (e) {
      setError(e.message || "Scan failed.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(market); setSectorFilter("any"); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [market]);

  // Company-type filter options come from the scanned rows themselves.
  const sectors = useMemo(
    () => [...new Set(rows.map((r) => r.sector).filter(Boolean))].sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const f = {
      minChange: minChange === "" ? null : parseFloat(minChange),
      maxChange: null,
      rsi: rsiFilter,
      trend: trendFilter,
      minVolume: null,
    };
    let out = applyFilters(rows, f);
    if (sectorFilter !== "any") out = out.filter((r) => r.sector === sectorFilter);
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    return [...out].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv) * mul;
      return (av - bv) * mul;
    });
  }, [rows, minChange, rsiFilter, trendFilter, sectorFilter, sort]);

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const cols = market === "stock" ? 8 : 6;

  const Th = ({ label, k, right }) => (
    <th className={cn("px-3 py-2 font-medium cursor-pointer select-none whitespace-nowrap", right && "text-right")}
      onClick={() => toggleSort(k)}>
      <span className="inline-flex items-center gap-1">
        {label}<ArrowUpDown className={cn("w-3 h-3", sort.key === k ? "text-accent" : "text-dim/55")} />
      </span>
    </th>
  );

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Scanner</p>
      <h1 className="text-xl sm:text-2xl font-bold mb-4 sm:mb-6">Screener</h1>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex gap-1">
          {MARKETS.map((m) => (
            <button key={m.id} onClick={() => setMarket(m.id)}
              className={cn("chip", market === m.id ? "chip-active" : "chip-idle")}>
              {m.label}
            </button>
          ))}
        </div>
        <select aria-label="RSI filter" value={rsiFilter} onChange={(e) => setRsiFilter(e.target.value)} className="input-base text-sm">
          {RSI_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select aria-label="Trend filter" value={trendFilter} onChange={(e) => setTrendFilter(e.target.value)} className="input-base text-sm">
          {TREND_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        {market === "stock" && (
          <select aria-label="Sector filter" value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)} className="input-base text-sm">
            <option value="any">Sector: all</option>
            {sectors.map((sec) => <option key={sec} value={sec}>{sec}</option>)}
          </select>
        )}
        <label className="flex items-center gap-1.5 text-xs text-dim">
          Change ≥
          <input type="number" value={minChange} onChange={(e) => setMinChange(e.target.value)}
            placeholder="%" className="input-base font-mono w-20 text-sm" />
        </label>
        <button onClick={() => load()} disabled={loading}
          className="btn-ghost flex items-center gap-1.5 ml-auto" title="Rescan">
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> Scan
        </button>
      </div>

      <p className="text-xs text-dim mb-3">
        {loading ? "Scanning market…" : `${filtered.length} of ${rows.length} symbols`}
        {market === "crypto" ? " · Top 30 by volume" : " · curated stock universe"}
      </p>

      {/* A screen is a statement about a LIST. Symbols the data proxy refused
          (usually a rate limit) used to vanish from the results with nothing
          said, so a partial scan read exactly like a complete one. */}
      {missing && (
        <div className="rounded-xl border border-warn/40 bg-warn/5 px-4 py-2.5 mb-3 text-[12px] leading-relaxed text-warn">
          <b>Partial scan.</b>{" "}
          <span className="text-dim">
            {missing.syms.length} of {missing.of} symbols could not be loaded
            ({missing.syms.slice(0, 8).join(", ")}{missing.syms.length > 8 ? "…" : ""}) and are missing
            from the results below. Usually a rate limit on the data proxy — rescanning in a minute
            normally fixes it.
          </span>
        </div>
      )}

      <div className="rounded-xl border border-line lg-glass overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-dim text-xs border-b border-line">
                <Th label="Symbol" k="symbol" />
                <Th label="Price" k="price" right />
                <Th label="24h %" k="changePct" right />
                {market === "stock" && <Th label="Sector" k="sector" />}
                {market === "stock" && <Th label="Employees" k="employees" right />}
                <Th label="Volume" k="volume" right />
                <Th label="RSI" k="rsi" right />
                <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Trend</th>
              </tr>
            </thead>
            <tbody>
              {error ? (
                <tr><td colSpan={cols} className="px-4 py-8 text-center text-down">{error}</td></tr>
              ) : loading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i} className="border-b border-line/40">
                    <td className="px-3 py-3"><div className="h-3 w-24 skeleton rounded" /></td>
                    <td colSpan={cols - 1} className="px-3 py-3"><div className="h-3 w-full bg-line/50 rounded" /></td>
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr><td colSpan={cols} className="px-4 py-8 text-center text-dim">No matches for these filters.</td></tr>
              ) : (
                filtered.map((r) => (
                  <tr key={`${r.market}:${r.symbol}`}
                    onClick={() => navigate(`/charts?market=${r.market}&symbol=${r.symbol}`)}
                    className="border-b border-line/40 last:border-0 hover:bg-bg/60 cursor-pointer transition-colors">
                    <td className="px-3 py-2.5">
                      <span className="font-mono font-semibold">{r.symbol}</span>
                      <span className="text-dim ml-2 hidden sm:inline">{r.name}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono">{fmtPrice(r.price)}</td>
                    <td className={cn("px-3 py-2.5 text-right font-mono", r.changePct > 0 ? "text-up" : r.changePct < 0 ? "text-down" : "text-dim")}>
                      {fmtPct(r.changePct)}
                    </td>
                    {market === "stock" && (
                      <td className="px-3 py-2.5 text-dim whitespace-nowrap">{r.sector || "–"}</td>
                    )}
                    {market === "stock" && (
                      <td className="px-3 py-2.5 text-right font-mono text-dim">{r.employees != null ? fmtVol(r.employees) : "–"}</td>
                    )}
                    <td className="px-3 py-2.5 text-right font-mono text-dim">{fmtVol(r.volume)}</td>
                    <td className={cn("px-3 py-2.5 text-right font-mono", r.rsi == null ? "text-dim" : r.rsi < 30 ? "text-up" : r.rsi > 70 ? "text-down" : "text-text")}>
                      {r.rsi == null ? "–" : fmtNum(r.rsi, 0)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className="inline-flex gap-1 justify-end">
                        {r.sma50 != null && (
                          <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", r.price > r.sma50 ? "border-up/40 text-up" : "border-down/40 text-down")}>50</span>
                        )}
                        {r.sma200 != null && (
                          <span className={cn("text-[10px] px-1.5 py-0.5 rounded border", r.price > r.sma200 ? "border-up/40 text-up" : "border-down/40 text-down")}>200</span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-dim">
        Trend badges: green = price above the SMA (50/200), red = below. RSI: green = oversold (&lt;30),
        red = overbought (&gt;70). Sector &amp; employee counts are curated, approximate metadata. Click a row to open the chart. Not investment advice.
      </p>
    </div>
  );
}
