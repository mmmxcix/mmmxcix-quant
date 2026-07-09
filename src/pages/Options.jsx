import { useEffect, useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import SymbolSearch from "@/components/SymbolSearch";
import { fetchOptionChain } from "@/lib/options";
import { cn, fmtNum, fmtPrice, fmtPct } from "@/lib/utils";

function fmtExpiry(sec) {
  const d = new Date(sec * 1000);
  const days = Math.max(0, Math.round((sec - Date.now() / 1000) / 86400));
  return `${d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} (${days}d)`;
}

export default function Options() {
  const [params, setParams] = useSearchParams();
  const symbol = (params.get("symbol") || "AAPL").toUpperCase();

  const [side, setSide] = useState("calls");
  const [expiry, setExpiry] = useState(null); // unix seconds
  const [chain, setChain] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load chain when symbol or expiry changes.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchOptionChain(symbol, expiry)
      .then((c) => { if (alive) { setChain(c); if (expiry == null) setExpiry(c.expiry); } })
      .catch((e) => { if (alive) { setError(e.message); setChain(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol, expiry]);

  // Reset expiry when the symbol changes so we load its nearest one.
  const setSymbol = (s) => { setExpiry(null); setChain(null); setParams({ symbol: s }); };

  const rows = chain ? chain[side] : [];
  const spot = chain?.spot ?? null;

  // Strike nearest the spot (at-the-money) to highlight.
  const atmStrike = useMemo(() => {
    if (!rows.length || spot == null) return null;
    return rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best), rows[0].strike);
  }, [rows, spot]);

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Derivatives</p>
      <h1 className="text-xl sm:text-2xl font-bold mb-4 sm:mb-6">Options</h1>

      <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4">
        <SymbolSearch market="stock" value={symbol} onSelect={setSymbol}
          placeholder="e.g. AAPL, SPY, NVDA" className="w-full sm:w-64" />
        {chain?.expirations?.length > 0 && (
          <select value={expiry ?? ""} onChange={(e) => setExpiry(+e.target.value)} className="input-base text-sm">
            {chain.expirations.map((ex) => (
              <option key={ex} value={ex}>{fmtExpiry(ex)}</option>
            ))}
          </select>
        )}
        <div className="flex gap-1">
          <button onClick={() => setSide("calls")} className={cn("chip", side === "calls" ? "chip-active" : "chip-idle")}>Calls</button>
          <button onClick={() => setSide("puts")} className={cn("chip", side === "puts" ? "chip-active" : "chip-idle")}>Puts</button>
        </div>
        {spot != null && (
          <span className="text-sm font-mono text-dim ml-auto">
            Spot <span className="text-text">{fmtPrice(spot)}</span>
          </span>
        )}
      </div>

      <div className="rounded-xl border border-line lg-glass overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm font-mono whitespace-nowrap">
            <thead>
              <tr className="text-right text-dim text-xs border-b border-line">
                <th className="px-3 py-2 font-medium text-left">Strike</th>
                <th className="px-3 py-2 font-medium">Last</th>
                <th className="px-3 py-2 font-medium">Chg%</th>
                <th className="px-3 py-2 font-medium">Bid</th>
                <th className="px-3 py-2 font-medium">Ask</th>
                <th className="px-3 py-2 font-medium">IV</th>
                <th className="px-3 py-2 font-medium">Vol</th>
                <th className="px-3 py-2 font-medium">OI</th>
                <th className="px-3 py-2 font-medium" title="Delta">Δ</th>
                <th className="px-3 py-2 font-medium" title="Theta (per day)">Θ</th>
              </tr>
            </thead>
            <tbody>
              {error ? (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-down font-sans">{error}</td></tr>
              ) : loading && !chain ? (
                Array.from({ length: 12 }).map((_, i) => (
                  <tr key={i} className="border-b border-line/40 animate-pulse">
                    <td className="px-3 py-3"><div className="h-3 w-12 bg-line rounded" /></td>
                    <td colSpan={9} className="px-3 py-3"><div className="h-3 w-full bg-line/50 rounded" /></td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-dim font-sans">No contracts for this expiry.</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.strike}
                    className={cn("text-right border-b border-line/30 last:border-0",
                      r.inTheMoney && "bg-accent/[0.04]",
                      r.strike === atmStrike && "outline outline-1 outline-accent/40")}>
                    <td className="px-3 py-1.5 text-left font-semibold">{fmtNum(r.strike, r.strike >= 100 ? 0 : 1)}</td>
                    <td className="px-3 py-1.5">{r.last != null ? fmtNum(r.last) : "–"}</td>
                    <td className={cn("px-3 py-1.5", r.pctChange > 0 ? "text-up" : r.pctChange < 0 ? "text-down" : "text-dim")}>
                      {r.pctChange != null ? fmtPct(r.pctChange) : "–"}
                    </td>
                    <td className="px-3 py-1.5 text-dim">{r.bid != null ? fmtNum(r.bid) : "–"}</td>
                    <td className="px-3 py-1.5 text-dim">{r.ask != null ? fmtNum(r.ask) : "–"}</td>
                    <td className="px-3 py-1.5">{r.iv != null ? `${fmtNum(r.iv * 100, 0)}%` : "–"}</td>
                    <td className="px-3 py-1.5 text-dim">{r.volume ? fmtNum(r.volume, 0) : "–"}</td>
                    <td className="px-3 py-1.5 text-dim">{r.openInterest ? fmtNum(r.openInterest, 0) : "–"}</td>
                    <td className="px-3 py-1.5">{r.greeks.delta != null ? fmtNum(r.greeks.delta, 2) : "–"}</td>
                    <td className="px-3 py-1.5 text-dim">{r.greeks.theta != null ? fmtNum(r.greeks.theta, 2) : "–"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-3 text-[11px] text-dim">
        Highlighted row = at-the-money; tinted rows = in-the-money. IV comes from the market; Greeks
        (Δ delta, Θ theta) are computed via Black-Scholes. Data is delayed. New to this? See the{" "}
        <Link to="/academy" className="text-accent hover:underline">Options &amp; Derivatives course</Link> in the Academy.
        Not investment advice.
      </p>
    </div>
  );
}
