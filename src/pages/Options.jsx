import { useEffect, useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Plus, X, Trash2, ArrowLeftRight } from "lucide-react";
import SymbolSearch from "@/components/SymbolSearch";
import XYLineChart from "@/components/XYLineChart";
import { fetchOptionChain, markPrice, netCost, payoffCurve, positionGreeks, STRATEGY_PRESETS, fetchTermStructure } from "@/lib/options";
import { cn, fmtNum, fmtPrice, fmtPct } from "@/lib/utils";

function fmtExpiry(sec) {
  const d = new Date(sec * 1000);
  const days = Math.max(0, Math.round((sec - Date.now() / 1000) / 86400));
  return `${d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} (${days}d)`;
}
const money = (v) => (v == null ? "–" : `${v < 0 ? "-" : ""}$${fmtNum(Math.abs(v), 0)}`);
let legSeq = 1;

export default function Options() {
  const [params, setParams] = useSearchParams();
  const symbol = (params.get("symbol") || "AAPL").toUpperCase();

  const [side, setSide] = useState("calls");
  const [expiry, setExpiry] = useState(null);
  const [chain, setChain] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [legs, setLegs] = useState([]);

  // Term structure (lazy-loaded on demand)
  const [term, setTerm] = useState(null);
  const [termLoading, setTermLoading] = useState(false);

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

  const setSymbol = (s) => { setExpiry(null); setChain(null); setLegs([]); setTerm(null); setParams({ symbol: s }); };

  const loadTerm = () => {
    if (termLoading) return;
    setTermLoading(true);
    fetchTermStructure(symbol, 6)
      .then((pts) => setTerm(pts))
      .catch(() => setTerm([]))
      .finally(() => setTermLoading(false));
  };

  const rows = chain ? chain[side] : [];
  const spot = chain?.spot ?? null;

  const atmStrike = useMemo(() => {
    if (!rows.length || spot == null) return null;
    return rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best), rows[0].strike);
  }, [rows, spot]);

  // ── Position builder ──────────────────────────────────────────────────
  const addLeg = (r) => {
    const premium = markPrice(r);
    if (!(premium > 0)) return;
    setLegs((l) => [...l, {
      id: legSeq++, type: side === "calls" ? "call" : "put",
      strike: r.strike, premium: +premium.toFixed(2), side: "long", qty: 1, greeks: r.greeks,
    }]);
  };
  const applyPreset = (preset) => {
    if (!chain) return;
    const built = preset.build(chain);
    if (built) setLegs(built.map((l) => ({ ...l, id: legSeq++ })));
  };
  const flipLeg = (id) => setLegs((l) => l.map((x) => (x.id === id ? { ...x, side: x.side === "long" ? "short" : "long" } : x)));
  const setQty = (id, qty) => setLegs((l) => l.map((x) => (x.id === id ? { ...x, qty: Math.max(1, qty | 0) } : x)));
  const removeLeg = (id) => setLegs((l) => l.filter((x) => x.id !== id));

  const payoff = useMemo(() => (legs.length && spot ? payoffCurve(legs, spot) : null), [legs, spot]);
  const cost = useMemo(() => netCost(legs), [legs]);
  const posGreeks = useMemo(() => positionGreeks(legs), [legs]);

  const payoffSeries = payoff
    ? [{ label: "P/L at expiry", color: "#2dd4bf", points: payoff.points }]
    : null;

  // ── Volatility smile (IV across strikes for the current side) ──────────
  const smileSeries = useMemo(() => {
    const pts = rows.filter((r) => r.iv != null && r.iv > 0).map((r) => ({ x: r.strike, y: r.iv * 100 }));
    if (pts.length < 3) return null;
    return [{ label: side === "calls" ? "Call IV" : "Put IV", color: side === "calls" ? "#38bdf8" : "#f472b6", points: pts }];
  }, [rows, side]);

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Derivatives</p>
      <h1 className="text-xl sm:text-2xl font-bold mb-4 sm:mb-6">Options</h1>

      <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-4">
        <SymbolSearch market="stock" value={symbol} onSelect={setSymbol}
          placeholder="e.g. AAPL, SPY, NVDA" className="w-full sm:w-64" />
        {chain?.expirations?.length > 0 && (
          <select value={expiry ?? ""} onChange={(e) => setExpiry(+e.target.value)} className="input-base text-sm">
            {chain.expirations.map((ex) => <option key={ex} value={ex}>{fmtExpiry(ex)}</option>)}
          </select>
        )}
        <div className="flex gap-1">
          <button onClick={() => setSide("calls")} className={cn("chip", side === "calls" ? "chip-active" : "chip-idle")}>Calls</button>
          <button onClick={() => setSide("puts")} className={cn("chip", side === "puts" ? "chip-active" : "chip-idle")}>Puts</button>
        </div>
        {spot != null && <span className="text-sm font-mono text-dim ml-auto">Spot <span className="text-text">{fmtPrice(spot)}</span></span>}
      </div>

      <div className="grid lg:grid-cols-[1fr_340px] gap-4 items-start">
        {/* Chain table */}
        <div className="rounded-xl border border-line lg-glass overflow-hidden">
          <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
            <table className="w-full text-xs sm:text-sm font-mono whitespace-nowrap">
              <thead className="sticky top-0 bg-surface z-10">
                <tr className="text-right text-dim text-xs border-b border-line">
                  <th className="px-3 py-2 font-medium text-left">Strike</th>
                  <th className="px-3 py-2 font-medium">Last</th>
                  <th className="px-3 py-2 font-medium">Bid</th>
                  <th className="px-3 py-2 font-medium">Ask</th>
                  <th className="px-3 py-2 font-medium">IV</th>
                  <th className="px-3 py-2 font-medium">Vol</th>
                  <th className="px-3 py-2 font-medium">OI</th>
                  <th className="px-3 py-2 font-medium" title="Delta">Δ</th>
                  <th className="px-3 py-2 font-medium" title="Theta / day">Θ</th>
                  <th className="px-3 py-2 font-medium"></th>
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
                      className={cn("text-right border-b border-line/30 last:border-0 hover:bg-bg/60",
                        r.inTheMoney && "bg-accent/[0.04]",
                        r.strike === atmStrike && "outline outline-1 outline-accent/40")}>
                      <td className="px-3 py-1.5 text-left font-semibold">{fmtNum(r.strike, r.strike >= 100 ? 0 : 1)}</td>
                      <td className="px-3 py-1.5">{r.last != null ? fmtNum(r.last) : "–"}</td>
                      <td className="px-3 py-1.5 text-dim">{r.bid != null ? fmtNum(r.bid) : "–"}</td>
                      <td className="px-3 py-1.5 text-dim">{r.ask != null ? fmtNum(r.ask) : "–"}</td>
                      <td className="px-3 py-1.5">{r.iv != null ? `${fmtNum(r.iv * 100, 0)}%` : "–"}</td>
                      <td className="px-3 py-1.5 text-dim">{r.volume ? fmtNum(r.volume, 0) : "–"}</td>
                      <td className="px-3 py-1.5 text-dim">{r.openInterest ? fmtNum(r.openInterest, 0) : "–"}</td>
                      <td className="px-3 py-1.5">{r.greeks.delta != null ? fmtNum(r.greeks.delta, 2) : "–"}</td>
                      <td className="px-3 py-1.5 text-dim">{r.greeks.theta != null ? fmtNum(r.greeks.theta, 2) : "–"}</td>
                      <td className="px-2 py-1.5">
                        <button onClick={() => addLeg(r)} title="Add to position"
                          className="p-1 rounded text-dim hover:text-accent hover:bg-accent/10 transition-colors">
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Position builder */}
        <div className="rounded-xl border border-line lg-glass p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-dim uppercase tracking-widest">Position builder</p>
            {legs.length > 0 && (
              <button onClick={() => setLegs([])} className="text-dim hover:text-down transition-colors" title="Clear all">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Strategy presets */}
          <div className="mb-3">
            <p className="text-[10px] text-dim uppercase tracking-widest mb-1.5">Presets</p>
            <div className="flex flex-wrap gap-1">
              {STRATEGY_PRESETS.map((p) => (
                <button key={p.id} onClick={() => applyPreset(p)} disabled={!chain}
                  className="chip chip-idle text-[11px] disabled:opacity-40">
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {legs.length === 0 ? (
            <p className="text-sm text-dim">Pick a preset above, or click <Plus className="inline w-3.5 h-3.5" /> on a contract to add legs manually. Presets use strikes around the current spot for the selected expiry.</p>
          ) : (
            <>
              <div className="space-y-1.5 mb-3">
                {legs.map((l) => (
                  <div key={l.id} className="flex items-center gap-2 text-xs font-mono">
                    <button onClick={() => flipLeg(l.id)} title="Long / short"
                      className={cn("px-1.5 py-0.5 rounded border text-[10px] font-semibold w-14 flex items-center justify-center gap-1",
                        l.side === "long" ? "border-up/40 text-up" : "border-down/40 text-down")}>
                      <ArrowLeftRight className="w-3 h-3" />{l.side === "long" ? "LONG" : "SHORT"}
                    </button>
                    <input type="number" value={l.qty} min={1} onChange={(e) => setQty(l.id, +e.target.value)}
                      className="input-base w-12 !px-1.5 !py-0.5 text-center" />
                    <span className="flex-1">
                      {l.kind === "stock"
                        ? `${l.qty * 100} sh @ ${fmtNum(l.entry)}`
                        : `${l.type === "call" ? "C" : "P"} ${fmtNum(l.strike, l.strike >= 100 ? 0 : 1)} @ ${fmtNum(l.premium)}`}
                    </span>
                    <button onClick={() => removeLeg(l.id)} className="text-dim hover:text-down"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                <Stat label={cost < 0 ? "Net debit" : "Net credit"} value={money(Math.abs(cost))} tone={cost < 0 ? "text-down" : "text-up"} />
                <Stat label="Max profit" value={payoff && isFinite(payoff.maxProfit) ? money(payoff.maxProfit) : "unbounded"} tone="text-up" />
                <Stat label="Max loss" value={payoff && isFinite(payoff.maxLoss) ? money(payoff.maxLoss) : "unbounded"} tone="text-down" />
                <Stat label="Breakeven" value={payoff?.breakevens.length ? payoff.breakevens.map((b) => fmtNum(b, 0)).join(", ") : "–"} />
              </div>

              {posGreeks && (
                <div className="grid grid-cols-4 gap-2 text-xs mb-3">
                  <Stat label="Δ Delta" value={fmtNum(posGreeks.delta, 0)} tone={posGreeks.delta >= 0 ? "text-up" : "text-down"} />
                  <Stat label="Γ Gamma" value={fmtNum(posGreeks.gamma, 1)} />
                  <Stat label="Θ Theta/d" value={money(posGreeks.theta)} tone={posGreeks.theta >= 0 ? "text-up" : "text-down"} />
                  <Stat label="V Vega" value={money(posGreeks.vega)} />
                </div>
              )}

              {payoffSeries && (
                <div>
                  <p className="text-[10px] text-dim uppercase tracking-widest mb-1">P/L at expiry</p>
                  <XYLineChart
                    series={payoffSeries}
                    height={220}
                    shadeZero
                    markerX={spot}
                    markerLabel="Spot"
                    fmtX={(v) => fmtNum(v, 0)}
                    fmtY={(v) => money(v)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Volatility smile */}
      {smileSeries && (
        <div className="rounded-xl border border-line lg-glass p-4 mt-4">
          <p className="text-xs text-dim uppercase tracking-widest mb-1">
            Volatility smile — implied volatility across strikes ({side})
          </p>
          <XYLineChart
            series={smileSeries}
            height={240}
            zeroLine={false}
            markerX={atmStrike}
            markerLabel="ATM"
            fmtX={(v) => fmtNum(v, 0)}
            fmtY={(v) => `${fmtNum(v, 0)}%`}
          />
          <p className="text-[11px] text-dim mt-2">
            A U- or skew-shaped curve means out-of-the-money options carry richer implied volatility —
            the market pricing in tail risk. See the Academy's Options course for why.
          </p>
        </div>
      )}

      {/* Term structure */}
      <div className="rounded-xl border border-line lg-glass p-4 mt-4">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs text-dim uppercase tracking-widest">Volatility term structure — ATM IV by expiry</p>
          {!term && (
            <button onClick={loadTerm} disabled={termLoading} className="chip chip-idle text-[11px]">
              {termLoading ? "Loading…" : "Load"}
            </button>
          )}
        </div>
        {term && term.length >= 2 ? (
          <XYLineChart
            series={[{ label: "ATM IV", color: "#2dd4bf", points: term.map((t) => ({ x: t.dte, y: t.iv })) }]}
            height={220}
            zeroLine={false}
            fmtX={(v) => `${fmtNum(v, 0)}d`}
            fmtY={(v) => `${fmtNum(v, 0)}%`}
          />
        ) : term ? (
          <p className="text-sm text-dim">Not enough expirations with IV to plot.</p>
        ) : (
          <p className="text-sm text-dim">
            Loads ATM implied volatility across the next few expirations. An upward slope (contango) is normal;
            a downward slope (backwardation) often signals near-term stress.
          </p>
        )}
      </div>

      <p className="mt-3 text-[11px] text-dim">
        Highlighted row = at-the-money; tinted = in-the-money. IV comes from the market; Greeks and the payoff
        engine use Black-Scholes / expiry intrinsic value. Data is delayed. New to this? See the{" "}
        <Link to="/academy" className="text-accent hover:underline">Options &amp; Derivatives course</Link>.
        Not investment advice.
      </p>
    </div>
  );
}

function Stat({ label, value, tone = "text-text" }) {
  return (
    <div className="rounded-lg border border-line bg-bg/40 px-2.5 py-1.5">
      <p className="text-[10px] text-dim">{label}</p>
      <p className={cn("font-mono font-semibold text-xs", tone)}>{value}</p>
    </div>
  );
}
