import { useEffect, useState } from "react";
import { History, ClipboardCheck, Hourglass, RefreshCw, Loader2 } from "lucide-react";
import { cn, fmtPct, fmtNum } from "@/lib/utils";
import { getRuns, getPredictions, resolvePredictions, ledgerStats } from "@/lib/mlMemory";

// Track record — the studio's memory made visible. Two ledgers:
// 1. every run it has seen (config + out-of-sample score),
// 2. every LIVE prediction, resolved later against what really happened.
// The second one is the only ML evidence that grows with time.

const fmtWhen = (ts) =>
  new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " +
  new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export default function MLTrackRecord() {
  const [runs, setRuns] = useState(getRuns);
  const [preds, setPreds] = useState(getPredictions);
  const [stats, setStats] = useState(ledgerStats);
  const [resolving, setResolving] = useState(false);

  const refresh = () => {
    setRuns(getRuns());
    setPreds(getPredictions());
    setStats(ledgerStats());
  };

  // On mount: resolve anything resolvable, then show the updated ledger.
  useEffect(() => {
    let alive = true;
    (async () => {
      setResolving(true);
      await resolvePredictions();
      if (alive) { refresh(); setResolving(false); }
    })();
    return () => { alive = false; };
  }, []);

  const forecasts = preds.filter((p) => p.type === "forecast");
  const rankings = preds.filter((p) => p.type === "ranking");

  return (
    <div className="space-y-4">
      {/* Live scoreboard */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-line lg-glass px-4 py-3">
          <p className="text-[11px] text-dim mb-1">Live forecast hit rate</p>
          <p className={cn("font-mono font-semibold text-lg",
            stats.forecastHitRate == null ? "text-dim" : stats.forecastHitRate > 0.5 ? "text-up" : "text-down")}>
            {stats.forecastHitRate == null ? "–" : `${(stats.forecastHitRate * 100).toFixed(0)}%`}
          </p>
          <p className="text-xs text-dim mt-0.5">{stats.forecastN} resolved · real days, no backtest</p>
        </div>
        <div className="rounded-xl border border-line lg-glass px-4 py-3">
          <p className="text-[11px] text-dim mb-1">Ranking vs SPY</p>
          <p className={cn("font-mono font-semibold text-lg",
            stats.rankingAvgSpread == null ? "text-dim" : stats.rankingAvgSpread > 0 ? "text-up" : "text-down")}>
            {stats.rankingAvgSpread == null ? "–" : fmtPct(stats.rankingAvgSpread * 100)}
          </p>
          <p className="text-xs text-dim mt-0.5">{stats.rankingN} months resolved · avg 30-day spread</p>
        </div>
        <div className="rounded-xl border border-line lg-glass px-4 py-3">
          <p className="text-[11px] text-dim mb-1">Pending predictions</p>
          <p className="font-mono font-semibold text-lg">{stats.pending}</p>
          <p className="text-xs text-dim mt-0.5">waiting for reality to answer</p>
        </div>
        <div className="rounded-xl border border-line lg-glass px-4 py-3">
          <p className="text-[11px] text-dim mb-1">Runs remembered</p>
          <p className="font-mono font-semibold text-lg">{runs.length}</p>
          <p className="text-xs text-dim mt-0.5">configs + out-of-sample scores</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={async () => { setResolving(true); await resolvePredictions(); refresh(); setResolving(false); }}
          disabled={resolving} className="chip chip-idle flex items-center gap-1.5 !text-[11px]">
          {resolving ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Resolve now
        </button>
        <span className="text-[11px] text-dim">Predictions resolve automatically when you open this tab.</span>
      </div>

      {/* Prediction ledger */}
      <div className="rounded-xl border border-line lg-glass p-4">
        <div className="flex items-center gap-2 mb-2">
          <ClipboardCheck className="w-4 h-4 text-accent" />
          <p className="text-sm font-semibold">Prediction ledger</p>
        </div>
        {preds.length === 0 ? (
          <p className="text-sm text-dim">No predictions logged yet — run a forecast or a ranking, its live prediction lands here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-dim text-[10px] uppercase tracking-wide border-b border-line">
                  <th className="py-2 pr-3 font-medium">Made</th>
                  <th className="py-2 pr-3 font-medium">Prediction</th>
                  <th className="py-2 pr-3 font-medium text-right">Predicted</th>
                  <th className="py-2 pr-3 font-medium text-right">Actual</th>
                  <th className="py-2 font-medium text-right">Result</th>
                </tr>
              </thead>
              <tbody>
                {forecasts.slice(0, 30).map((p, i) => (
                  <tr key={`f${i}`} className="border-b border-line/40 last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs text-dim whitespace-nowrap">{fmtWhen(p.madeAt)}</td>
                    <td className="py-2 pr-3"><span className="font-mono font-semibold">{p.symbol}</span>
                      <span className="text-xs text-dim ml-2">next bar · {p.model}</span></td>
                    <td className={cn("py-2 pr-3 text-right font-mono text-xs", p.predRet >= 0 ? "text-up" : "text-down")}>{fmtPct(p.predRet * 100)}</td>
                    <td className={cn("py-2 pr-3 text-right font-mono text-xs", p.actualRet == null ? "text-dim" : p.actualRet >= 0 ? "text-up" : "text-down")}>
                      {p.actualRet == null ? "–" : fmtPct(p.actualRet * 100)}
                    </td>
                    <td className="py-2 text-right">
                      {!p.resolved ? <Hourglass className="w-3.5 h-3.5 inline text-dim" />
                        : p.hit ? <span className="text-up font-semibold text-xs">✓ direction</span>
                        : <span className="text-down font-semibold text-xs">✗ wrong</span>}
                    </td>
                  </tr>
                ))}
                {rankings.slice(0, 12).map((p, i) => (
                  <tr key={`r${i}`} className="border-b border-line/40 last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs text-dim whitespace-nowrap">{fmtWhen(p.madeAt)}</td>
                    <td className="py-2 pr-3"><span className="font-semibold text-xs">Top-10 ranking</span>
                      <span className="text-xs text-dim ml-2">{p.picks.slice(0, 5).join(" ")}…</span></td>
                    <td className="py-2 pr-3 text-right font-mono text-xs text-dim">beat SPY?</td>
                    <td className={cn("py-2 pr-3 text-right font-mono text-xs", p.spread == null ? "text-dim" : p.spread >= 0 ? "text-up" : "text-down")}>
                      {p.spread == null ? "–" : `${fmtPct(p.spread * 100)} vs SPY`}
                    </td>
                    <td className="py-2 text-right">
                      {!p.resolved ? <Hourglass className="w-3.5 h-3.5 inline text-dim" />
                        : p.spread >= 0 ? <span className="text-up font-semibold text-xs">✓ beat</span>
                        : <span className="text-down font-semibold text-xs">✗ lagged</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Run history */}
      <div className="rounded-xl border border-line lg-glass p-4">
        <div className="flex items-center gap-2 mb-2">
          <History className="w-4 h-4 text-accent" />
          <p className="text-sm font-semibold">Run history — what the studio has seen</p>
        </div>
        {runs.length === 0 ? (
          <p className="text-sm text-dim">No runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {runs.slice(0, 25).map((r, i) => (
                  <tr key={i} className="border-b border-line/40 last:border-0">
                    <td className="py-1.5 pr-3 font-mono text-xs text-dim whitespace-nowrap">{fmtWhen(r.ts)}</td>
                    <td className="py-1.5 pr-3 text-xs">{r.label}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-xs">
                      <span className="text-dim mr-1">{r.metricLabel}</span>
                      <span className={cn("font-semibold", r.metric > 0 ? "text-up" : "text-down")}>{fmtNum(r.metric, 3)}</span>
                    </td>
                    <td className="py-1.5 text-right text-xs text-dim hidden md:table-cell">{r.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-dim leading-relaxed">
        How the studio "learns", honestly: every run retrains on the latest, longer history (the
        legitimate improvement channel — these models can't learn incrementally between runs);
        the run log remembers which configs scored what out-of-sample; and the prediction ledger is
        graded by reality itself. Stored in this browser.
      </p>
    </div>
  );
}
