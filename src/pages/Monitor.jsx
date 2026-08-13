import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { fetchQuotes } from "@/lib/quotes";
import { ibkrActive, subscribeIbkr } from "@/lib/ibkr";
import { cn, fmtPrice, fmtPct } from "@/lib/utils";
// The instrument list lives in src/lib/universe.js so the monitor and the board
// (/api/board market.quotes) read ONE list instead of two that drift apart.
import { PANELS, ALL_ENTRIES } from "@/lib/universe";

// Bloomberg-terminal-style market overview: the instrument list comes from
// src/lib/universe.js (shared with the board); data via src/lib/quotes.js
// (one Binance call + throttled Yahoo chart calls).

function SkeletonRow() {
  return (
    <tr className="border-b border-line/40 last:border-0">
      <td className="px-3 py-1.5">
        <div className="h-3 w-20 rounded bg-line/60 animate-pulse" />
      </td>
      <td className="px-3 py-1.5">
        <div className="h-3 w-14 rounded bg-line/60 animate-pulse ml-auto" />
      </td>
      <td className="px-3 py-1.5">
        <div className="h-3 w-12 rounded bg-line/60 animate-pulse ml-auto" />
      </td>
    </tr>
  );
}

function QuoteRow({ entry, quote, onClick }) {
  const pct = quote?.changePct;
  const up = pct > 0;
  const down = pct < 0;
  return (
    <tr
      onClick={onClick}
      className="border-b border-line/40 last:border-0 hover:bg-bg/60 cursor-pointer transition-colors"
    >
      <td className="px-3 py-1.5 whitespace-nowrap">{entry.name}</td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap">
        {quote?.price == null ? <span className="text-dim">–</span> : fmtPrice(quote.price)}
      </td>
      <td
        className={cn(
          "px-3 py-1.5 text-right whitespace-nowrap",
          up ? "text-up" : down ? "text-down" : "text-dim"
        )}
      >
        {pct == null ? (
          "–"
        ) : (
          <>
            <span className="mr-1 text-[9px] align-middle">{up ? "▲" : down ? "▼" : ""}</span>
            {fmtPct(pct)}
          </>
        )}
      </td>
    </tr>
  );
}

function Panel({ panel, quotes, navigate }) {
  return (
    <section className="rounded-xl border border-line lg-glass overflow-hidden">
      <p className="px-3 pt-2.5 pb-1.5 text-[10px] tracking-[0.25em] text-dim uppercase border-b border-line">
        {panel.title}
      </p>
      <div className="overflow-x-auto"><table className="w-full text-xs font-mono [font-variant-numeric:tabular-nums]">
        <tbody>
          {panel.entries.map((e) =>
            quotes ? (
              <QuoteRow
                key={e.symbol}
                entry={e}
                quote={quotes.get(e.symbol)}
                onClick={() =>
                  navigate(`/charts?market=${e.market}&symbol=${encodeURIComponent(e.symbol)}`)
                }
              />
            ) : (
              <SkeletonRow key={e.symbol} />
            )
          )}
        </tbody>
      </table></div>
    </section>
  );
}

export default function Monitor() {
  const [quotes, setQuotes] = useState(null); // null until first load → skeletons
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [ibkr, setIbkr] = useState(ibkrActive());
  const navigate = useNavigate();
  const aliveRef = useRef(true);

  useEffect(() => {
    const update = () => setIbkr(ibkrActive());
    const unsub = subscribeIbkr(update);
    window.addEventListener("storage", update);
    return () => { unsub(); window.removeEventListener("storage", update); };
  }, []);

  // Background ticks are silent so the refresh spinner doesn't flicker at the
  // fast IBKR cadence.
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const map = await fetchQuotes(ALL_ENTRIES);
      if (!aliveRef.current) return;
      setQuotes(map);
      setUpdatedAt(new Date());
    } catch {
      // fetchQuotes tolerates per-symbol failures; on a total failure we keep
      // the previous data on screen instead of blanking the page.
    } finally {
      if (aliveRef.current && !silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    load();
    // With IBKR live quotes the gateway is local and rate-limit-free — poll
    // fast. Crypto stays served from the 30s client cache either way.
    const id = setInterval(() => load(true), ibkr ? 3_000 : 30_000);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [load, ibkr]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Market overview</p>
          <h1 className="text-2xl font-bold">Monitor</h1>
        </div>
        <div className="flex items-center gap-3">
          {ibkr && (
            <span className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs text-accent font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" /> IBKR live
            </span>
          )}
          {updatedAt && (
            <span className="text-xs text-dim font-mono">
              As of: {updatedAt.toLocaleTimeString("de-CH", { hour12: false })}
            </span>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-line lg-glass px-3 py-1.5 text-xs text-dim hover:text-text hover:border-accent/40 transition-colors disabled:opacity-60"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {PANELS.map((panel) => (
          <Panel key={panel.title} panel={panel} quotes={quotes} navigate={navigate} />
        ))}
      </div>
    </div>
  );
}
