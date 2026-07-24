import { useState } from "react";
import { CalendarSearch, Play, Loader2, AlertTriangle, Download } from "lucide-react";
import SymbolSearch from "@/components/SymbolSearch";
import Skeleton from "@/components/Skeleton";
import { fetchCandles } from "@/lib/data";
import { fetchStockInfo } from "@/lib/fundamentals";
import { eventStudy } from "@/lib/eventLab";
import { cn, fmtPct, fmtNum } from "@/lib/utils";

// Event Lab — the "how does this stock move on event days" study, done
// honestly: real distribution stats (mean/std/skew/kurtosis), the stock's
// ordinary day as the yardstick, straddle economics at a premium YOU set,
// and Kelly with the practitioner's quarter-Kelly next to it. Small samples
// are labelled as small samples.

function MetricCard({ label, value, sub, tone = "text-text" }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3">
      <p className="text-[11px] text-dim mb-1">{label}</p>
      <p className={cn("font-mono font-semibold text-lg", tone)}>{value}</p>
      {sub && <p className="text-xs text-dim mt-0.5">{sub}</p>}
    </div>
  );
}

export default function EventLab() {
  const [symbol, setSymbol] = useState("AAPL");
  const [datesText, setDatesText] = useState("");
  const [premium, setPremium] = useState("4");
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [out, setOut] = useState(null);
  const [ranFor, setRanFor] = useState("");

  // Prefill with the last earnings dates Yahoo knows (4 quarters) — a quick
  // starting point; paste more dates (one per line) for a real sample.
  const loadEarnings = async () => {
    setStatus("Loading earnings dates…");
    setError(null);
    try {
      const info = await fetchStockInfo(symbol.trim().toUpperCase());
      const dates = (info.quarters || [])
        .map((q) => q.quarter)
        .filter(Boolean);
      if (!dates.length) throw new Error("No earnings dates found for this symbol.");
      setDatesText((cur) => {
        const existing = new Set(cur.split(/\s+/).filter(Boolean));
        const merged = [...existing, ...dates.filter((d) => !existing.has(d))];
        return merged.join("\n");
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setStatus(null);
    }
  };

  const run = async () => {
    if (status) return;
    setError(null);
    setOut(null);
    const dates = datesText.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    if (dates.length < 3) { setError("Enter at least 3 event dates (YYYY-MM-DD, one per line) — e.g. past earnings or product launches."); return; }
    const prem = Number(String(premium).replace(",", "."));
    if (!(prem > 0 && prem < 50)) { setError("Straddle premium must be a % of spot between 0 and 50 (e.g. 4)."); return; }
    try {
      setStatus("Loading price history…");
      const sym = symbol.trim().toUpperCase();
      const candles = await fetchCandles({ market: "stock", symbol: sym, interval: "1d", range: "max" });
      setStatus("Running event study…");
      const res = eventStudy(candles, dates, prem);
      if (!res.ok) throw new Error(res.reason);
      setOut(res);
      setRanFor(sym);
    } catch (e) {
      setError(e.message);
    } finally {
      setStatus(null);
    }
  };

  const s = out?.stats, st = out?.straddle;

  return (
    <div>
      <div className="grid lg:grid-cols-[340px_1fr] gap-6 [&>*]:min-w-0">
        {/* controls */}
        <div className="space-y-4">
          <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
            <p className="text-xs text-dim font-medium">Event study</p>
            <SymbolSearch market="stock" value={symbol} onSelect={(v) => setSymbol(v.toUpperCase())}
              placeholder="e.g. AAPL" className="w-full" />
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-dim">Event dates (one per line)</span>
                <button onClick={loadEarnings} disabled={!!status}
                  className="chip chip-idle !text-[10px] flex items-center gap-1">
                  <Download className="w-3 h-3" /> load earnings dates
                </button>
              </div>
              <textarea
                value={datesText}
                onChange={(e) => setDatesText(e.target.value)}
                rows={7}
                placeholder={"2025-06-09\n2024-06-10\n2023-06-05\n…  (e.g. WWDC keynotes,\npast earnings, FDA dates)"}
                className="input-base w-full font-mono text-xs leading-relaxed"
              />
            </div>
            <label className="text-xs text-dim block">
              Straddle premium (% of spot, both legs)
              <input type="number" min="0.5" max="49" step="0.5" value={premium}
                onChange={(e) => setPremium(e.target.value)}
                className="input-base w-28 mt-1 font-mono block" />
              <span className="block text-[10px] text-dim mt-1">
                Check the real option chain for the expiry after your event — typical single-name
                earnings straddles run 3–7%.
              </span>
            </label>
            <button onClick={run} disabled={!!status} className="btn-accent w-full flex items-center justify-center gap-2 disabled:opacity-50">
              {status ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {status || "Run study"}
            </button>
            {error && (
              <p className="text-xs text-down flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
              </p>
            )}
          </div>
        </div>

        {/* results */}
        <div className="space-y-4">
          {!out && !status && (
            <div className="rounded-xl border border-line lg-glass p-10 text-center">
              <CalendarSearch className="w-8 h-8 text-dim mx-auto mb-3" />
              <p className="font-semibold mb-1">How does a stock really move on its big days?</p>
              <p className="text-sm text-dim max-w-lg mx-auto leading-relaxed">
                Paste event dates (earnings, keynotes, FDA decisions), and get the honest
                distribution of event-day moves, what an ATM straddle would have paid at your
                premium, and what Kelly says about sizing it. Small samples stay labelled as such.
              </p>
            </div>
          )}
          {status && !out && <Skeleton className="h-64 w-full rounded-xl" />}
          {out && (
            <>
              {out.n < 8 && (
                <p className="text-xs text-warn flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  Only {out.n} events — treat every number below as an anecdote with error bars, not a law.
                  Add more dates for a real sample.
                </p>
              )}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <MetricCard label="Mean event move" value={fmtPct(s.meanPct)}
                  sub={`σ ${s.stdPct}% · ${out.n} events`} tone={s.meanPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="Mean |move|" value={`${s.meanAbsPct}%`}
                  sub={s.moveRatio != null ? `${s.moveRatio}× a typical day (${s.typicalAbsPct}%)` : ""}
                  tone={s.moveRatio >= 2 ? "text-up" : "text-text"} />
                <MetricCard label="Skew" value={fmtNum(s.skew, 2)}
                  sub={s.skew > 0.3 ? "surprises lean upward" : s.skew < -0.3 ? "surprises lean downward" : "roughly symmetric"} />
                <MetricCard label="Excess kurtosis" value={fmtNum(s.kurtosis, 2)}
                  sub={s.kurtosis > 1 ? "fat tails — jumps happen" : "tails ≈ normal"} />
              </div>

              {/* per-event bars */}
              <div className="rounded-xl border border-line lg-glass p-4">
                <p className="text-sm font-semibold mb-3">Event-day returns — {ranFor}</p>
                <div className="flex items-end gap-2 h-40 overflow-x-auto pb-1">
                  {out.rows.map((r) => {
                    const maxAbs = Math.max(...out.rows.map((x) => Math.abs(x.retPct)), 0.01);
                    const h = (Math.abs(r.retPct) / maxAbs) * 100;
                    return (
                      <div key={r.date} className="flex flex-col items-center justify-end h-full shrink-0" title={`${r.date}: ${r.retPct >= 0 ? "+" : ""}${r.retPct}% (traded ${r.tradedOn})`}>
                        <span className={cn("text-[9px] font-mono mb-1", r.retPct >= 0 ? "text-up" : "text-down")}>
                          {r.retPct >= 0 ? "+" : ""}{r.retPct}%
                        </span>
                        <div className={cn("w-8 rounded-t", r.retPct >= 0 ? "bg-up/70" : "bg-down/70")} style={{ height: `${Math.max(3, h)}%` }} />
                        <span className="text-[9px] text-dim mt-1 font-mono">{r.date.slice(2, 7)}</span>
                      </div>
                    );
                  })}
                </div>
                {/* premium line note */}
                <p className="text-[11px] text-dim mt-2">
                  Straddle break-even at ±{st.premiumPct}% — bars taller than that (in either direction) were straddle wins.
                </p>
              </div>

              {/* straddle + kelly */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-line lg-glass p-4">
                  <p className="text-sm font-semibold mb-2">ATM straddle at {st.premiumPct}% premium</p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs font-mono">
                    <span className="text-dim">Win rate</span><span className={cn("text-right font-semibold", st.winRatePct > 50 ? "text-up" : "text-down")}>{st.winRatePct}%</span>
                    <span className="text-dim">Avg win</span><span className="text-right text-up">+{st.avgWinPct}%</span>
                    <span className="text-dim">Avg loss</span><span className="text-right text-down">−{st.avgLossPct}%</span>
                    <span className="text-dim">Payoff ratio (b)</span><span className="text-right">{st.payoffRatio}</span>
                    <span className="text-dim">Avg P&L / event</span>
                    <span className={cn("text-right font-semibold", st.avgPnlPct >= 0 ? "text-up" : "text-down")}>{st.avgPnlPct >= 0 ? "+" : ""}{st.avgPnlPct}%</span>
                  </div>
                  <p className="text-[11px] text-dim mt-2 leading-relaxed">
                    Buying a call + put at the money: you profit when the move beats the premium,
                    whichever direction. The market prices these — a negative avg P&L means the
                    options were "correctly expensive" for these events.
                  </p>
                </div>
                <div className="rounded-xl border border-line lg-glass p-4">
                  <p className="text-sm font-semibold mb-2">Kelly sizing</p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs font-mono">
                    <span className="text-dim">Full Kelly f*</span>
                    <span className={cn("text-right font-semibold", st.kellyPct > 0 ? "text-up" : "text-down")}>{st.kellyPct}%</span>
                    <span className="text-dim">Quarter Kelly</span><span className="text-right">{st.quarterKellyPct}%</span>
                  </div>
                  <p className="text-[11px] text-dim mt-2 leading-relaxed">
                    f* = p − (1−p)/b, from the win rate and payoff above. {st.kellyPct <= 0
                      ? "Zero means Kelly says DON'T take this bet at this premium — the edge isn't there."
                      : "Full Kelly assumes the estimates are exact (they aren't, with this sample size) — practitioners size at a quarter of it."}
                  </p>
                </div>
              </div>

              <p className="text-xs text-dim leading-relaxed">
                Event-day move = prior close → event close (the overnight announcement window).
                Educational study on historical closes — real straddles carry IV crush, spreads and
                assignment mechanics the closes can't see. Not investment advice.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
