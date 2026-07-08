import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, ArrowUpDown } from "lucide-react";
import { scanCrypto, scanStocks, applyFilters } from "@/lib/screener";
import { MARKETS } from "@/lib/data";
import { cn, fmtPrice, fmtPct, fmtNum } from "@/lib/utils";

const RSI_OPTS = [
  { id: "any", label: "RSI: alle" },
  { id: "oversold", label: "Überverkauft (<30)" },
  { id: "overbought", label: "Überkauft (>70)" },
];
const TREND_OPTS = [
  { id: "any", label: "Trend: alle" },
  { id: "above50", label: "Über SMA 50" },
  { id: "below50", label: "Unter SMA 50" },
  { id: "above200", label: "Über SMA 200" },
  { id: "below200", label: "Unter SMA 200" },
];

// Compact volume: 1.2 Mrd / 3.4 Mio / 5.6 Tsd
function fmtVol(v) {
  if (v == null || Number.isNaN(v)) return "–";
  if (v >= 1e9) return `${fmtNum(v / 1e9, 1)} Mrd`;
  if (v >= 1e6) return `${fmtNum(v / 1e6, 1)} Mio`;
  if (v >= 1e3) return `${fmtNum(v / 1e3, 1)} Tsd`;
  return fmtNum(v, 0);
}

export default function Screener() {
  const navigate = useNavigate();
  const [market, setMarket] = useState("crypto");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [rsiFilter, setRsiFilter] = useState("any");
  const [trendFilter, setTrendFilter] = useState("any");
  const [minChange, setMinChange] = useState("");
  const [sort, setSort] = useState({ key: "volume", dir: "desc" });

  const load = async (m = market) => {
    setLoading(true);
    setError(null);
    try {
      const data = m === "crypto" ? await scanCrypto({ limit: 30 }) : await scanStocks();
      setRows(data);
    } catch (e) {
      setError(e.message || "Scan fehlgeschlagen.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(market); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [market]);

  const filtered = useMemo(() => {
    const f = {
      minChange: minChange === "" ? null : parseFloat(minChange),
      maxChange: null,
      rsi: rsiFilter,
      trend: trendFilter,
      minVolume: null,
    };
    const out = applyFilters(rows, f);
    const { key, dir } = sort;
    const mul = dir === "asc" ? 1 : -1;
    return [...out].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv) * mul;
      return (av - bv) * mul;
    });
  }, [rows, minChange, rsiFilter, trendFilter, sort]);

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const Th = ({ label, k, right }) => (
    <th className={cn("px-3 py-2 font-medium cursor-pointer select-none whitespace-nowrap", right && "text-right")}
      onClick={() => toggleSort(k)}>
      <span className="inline-flex items-center gap-1">
        {label}<ArrowUpDown className={cn("w-3 h-3", sort.key === k ? "text-accent" : "text-dim/40")} />
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
        <select value={rsiFilter} onChange={(e) => setRsiFilter(e.target.value)} className="input-base text-sm">
          {RSI_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <select value={trendFilter} onChange={(e) => setTrendFilter(e.target.value)} className="input-base text-sm">
          {TREND_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-dim">
          Änderung ≥
          <input type="number" value={minChange} onChange={(e) => setMinChange(e.target.value)}
            placeholder="%" className="input-base font-mono w-20 text-sm" />
        </label>
        <button onClick={() => load()} disabled={loading}
          className="btn-ghost flex items-center gap-1.5 ml-auto" title="Neu scannen">
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} /> Scannen
        </button>
      </div>

      <p className="text-xs text-dim mb-3">
        {loading ? "Scanne Markt…" : `${filtered.length} von ${rows.length} Werten`}
        {market === "crypto" ? " · Top 30 nach Volumen" : " · kuratiertes Aktien-Universum"}
      </p>

      <div className="rounded-xl border border-line lg-glass overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-dim text-xs border-b border-line">
                <Th label="Symbol" k="symbol" />
                <Th label="Kurs" k="price" right />
                <Th label="24h %" k="changePct" right />
                <Th label="Volumen" k="volume" right />
                <Th label="RSI" k="rsi" right />
                <th className="px-3 py-2 font-medium text-right whitespace-nowrap">Trend</th>
              </tr>
            </thead>
            <tbody>
              {error ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-down">{error}</td></tr>
              ) : loading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i} className="border-b border-line/40 animate-pulse">
                    <td className="px-3 py-3"><div className="h-3 w-24 bg-line rounded" /></td>
                    <td colSpan={5} className="px-3 py-3"><div className="h-3 w-full bg-line/50 rounded" /></td>
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-dim">Keine Treffer für diese Filter.</td></tr>
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
        Trend-Badges: grün = Kurs über dem SMA (50/200), rot = darunter. RSI: grün = überverkauft (&lt;30),
        rot = überkauft (&gt;70). Klick auf eine Zeile öffnet den Chart. Keine Anlageberatung.
      </p>
    </div>
  );
}
