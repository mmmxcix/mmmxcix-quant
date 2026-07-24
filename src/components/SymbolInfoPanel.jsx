import { useEffect, useState } from "react";
import { Info, ExternalLink, CalendarClock } from "lucide-react";
import { fetchStockInfo, cryptoInfoFor } from "@/lib/fundamentals";
import Skeleton from "@/components/Skeleton";
import { cn, fmtPrice, fmtNum, fmtPct } from "@/lib/utils";

// "What IS this symbol?" — company/asset profile plus real fundamentals beyond
// the price: analyst targets, quarterly EPS estimate vs. delivered (beat/miss),
// margins, next earnings date. Crypto gets a curated identity blurb (there are
// no earnings to report on a coin). Toggled from the Charts toolbar.

function Stat({ label, value, tone }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-dim mb-0.5">{label}</p>
      <p className={cn("font-mono text-sm font-semibold", tone || "text-text")}>{value}</p>
    </div>
  );
}

export default function SymbolInfoPanel({ market, symbol }) {
  const [state, setState] = useState({ loading: true, error: null, info: null });
  const [expanded, setExpanded] = useState(false);
  const isCrypto = market === "crypto";

  useEffect(() => {
    setExpanded(false);
    if (isCrypto) {
      const { summary } = cryptoInfoFor(symbol);
      setState({ loading: false, error: null, info: { summary } });
      return;
    }
    let alive = true;
    setState({ loading: true, error: null, info: null });
    fetchStockInfo(symbol)
      .then((info) => alive && setState({ loading: false, error: null, info }))
      .catch((e) => alive && setState({ loading: false, error: e.message, info: null }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, symbol]);

  const { loading, error, info } = state;

  if (loading) {
    return (
      <div className="rounded-xl border border-line lg-glass p-4 mb-4 space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line lg-glass p-4 mb-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Info className="w-4 h-4 text-accent" />
        <span className="font-semibold text-sm">About {symbol}</span>
        {info?.sector && (
          <span className="chip chip-idle !cursor-default !text-[10px] !py-0.5">{info.sector}</span>
        )}
        {info?.industry && info.industry !== info.sector && (
          <span className="chip chip-idle !cursor-default !text-[10px] !py-0.5">{info.industry}</span>
        )}
        {info?.employees != null && (
          <span className="text-[11px] text-dim">{Intl.NumberFormat("en-US").format(info.employees)} employees</span>
        )}
        {info?.website && (
          <a href={info.website} target="_blank" rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-accent hover:underline">
            {info.website.replace(/^https?:\/\/(www\.)?/, "")} <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {error && <p className="text-sm text-dim">No profile data available for this symbol ({error}).</p>}

      {info?.summary ? (
        <div>
          <p className={cn("text-sm text-dim leading-relaxed", !expanded && "line-clamp-3")}>{info.summary}</p>
          {info.summary.length > 260 && (
            <button onClick={() => setExpanded((v) => !v)} className="mt-1 text-[11px] text-accent hover:underline">
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      ) : !error && (
        <p className="text-sm text-dim">No curated description for this symbol yet.</p>
      )}

      {/* Fundamentals — stocks only (a coin has no earnings to report). */}
      {!isCrypto && info && !error && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 border-t border-line pt-3">
            <Stat label="Analyst target" value={info.targetMean != null ? fmtPrice(info.targetMean) : "–"}
              tone={info.targetMean != null && info.price != null ? (info.targetMean >= info.price ? "text-up" : "text-down") : undefined} />
            <Stat label="Upside to target" value={
              info.targetMean != null && info.price > 0 ? fmtPct(((info.targetMean / info.price) - 1) * 100) : "–"
            } tone={info.targetMean != null && info.price != null ? (info.targetMean >= info.price ? "text-up" : "text-down") : undefined} />
            <Stat label="Rating" value={info.recommendation ? `${info.recommendation}${info.analysts ? ` (${info.analysts})` : ""}` : "–"} />
            <Stat label="Fwd P/E" value={info.forwardPE != null ? fmtNum(info.forwardPE, 1) : "–"} />
            <Stat label="Profit margin" value={info.profitMargin != null ? fmtPct(info.profitMargin * 100).replace("+", "") : "–"} />
            <Stat label="Rev growth (yoy)" value={info.revenueGrowth != null ? fmtPct(info.revenueGrowth * 100) : "–"}
              tone={info.revenueGrowth != null ? (info.revenueGrowth >= 0 ? "text-up" : "text-down") : undefined} />
          </div>

          {info.quarters?.length > 0 && (
            <div className="border-t border-line pt-3">
              <p className="text-[10px] uppercase tracking-wide text-dim mb-2">
                Quarterly earnings — expected vs. delivered (EPS)
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-left text-dim border-b border-line">
                      <th className="py-1 pr-4 font-medium font-sans">Quarter</th>
                      <th className="py-1 pr-4 font-medium font-sans text-right">Estimate</th>
                      <th className="py-1 pr-4 font-medium font-sans text-right">Actual</th>
                      <th className="py-1 font-medium font-sans text-right">Surprise</th>
                    </tr>
                  </thead>
                  <tbody>
                    {info.quarters.map((q) => {
                      const beat = q.actual != null && q.est != null ? q.actual >= q.est : null;
                      return (
                        <tr key={q.quarter} className="border-b border-line/40 last:border-0">
                          <td className="py-1.5 pr-4">{q.quarter}</td>
                          <td className="py-1.5 pr-4 text-right text-dim">{q.est != null ? fmtNum(q.est, 2) : "–"}</td>
                          <td className={cn("py-1.5 pr-4 text-right", beat == null ? "" : beat ? "text-up" : "text-down")}>
                            {q.actual != null ? fmtNum(q.actual, 2) : "–"}
                          </td>
                          <td className="py-1.5 text-right">
                            {q.surprisePct != null ? (
                              <span className={cn("inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                                q.surprisePct >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down")}>
                                {q.surprisePct >= 0 ? "beat +" : "miss "}{fmtNum(Math.abs(q.surprisePct), 1)}%
                              </span>
                            ) : "–"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {info.nextEarnings && (
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-dim">
                  <CalendarClock className="w-3.5 h-3.5" /> Next earnings: <span className="text-text font-mono">{info.nextEarnings}</span>
                </p>
              )}
            </div>
          )}
        </>
      )}

      <p className="text-[10px] text-dim">Data: Yahoo Finance via this site's proxy · descriptions for crypto are curated · not investment advice.</p>
    </div>
  );
}
