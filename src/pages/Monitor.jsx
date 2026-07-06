import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { fetchQuotes } from "@/lib/quotes";
import { cn, fmtPrice, fmtPct } from "@/lib/utils";

// Bloomberg-terminal-style market overview: static panel config here, data
// via src/lib/quotes.js (one Binance call + throttled Yahoo chart calls).
const PANELS = [
  {
    title: "Indizes",
    entries: [
      { market: "stock", symbol: "^GSPC", name: "S&P 500" },
      { market: "stock", symbol: "^NDX", name: "Nasdaq 100" },
      { market: "stock", symbol: "^DJI", name: "Dow Jones" },
      { market: "stock", symbol: "^GDAXI", name: "DAX" },
      { market: "stock", symbol: "^SSMI", name: "SMI" },
      { market: "stock", symbol: "^N225", name: "Nikkei 225" },
      { market: "stock", symbol: "^FTSE", name: "FTSE 100" },
    ],
  },
  {
    title: "Krypto",
    entries: [
      { market: "crypto", symbol: "BTCUSDT", name: "Bitcoin" },
      { market: "crypto", symbol: "ETHUSDT", name: "Ethereum" },
      { market: "crypto", symbol: "SOLUSDT", name: "Solana" },
      { market: "crypto", symbol: "BNBUSDT", name: "BNB" },
      { market: "crypto", symbol: "XRPUSDT", name: "XRP" },
      { market: "crypto", symbol: "DOGEUSDT", name: "Dogecoin" },
    ],
  },
  {
    title: "Rohstoffe",
    entries: [
      { market: "stock", symbol: "GC=F", name: "Gold" },
      { market: "stock", symbol: "SI=F", name: "Silber" },
      { market: "stock", symbol: "CL=F", name: "WTI Öl" },
      { market: "stock", symbol: "BZ=F", name: "Brent" },
      { market: "stock", symbol: "NG=F", name: "Erdgas" },
      { market: "stock", symbol: "HG=F", name: "Kupfer" },
    ],
  },
  {
    title: "Devisen",
    entries: [
      { market: "stock", symbol: "EURUSD=X", name: "EUR/USD" },
      { market: "stock", symbol: "GBPUSD=X", name: "GBP/USD" },
      { market: "stock", symbol: "USDJPY=X", name: "USD/JPY" },
      { market: "stock", symbol: "USDCHF=X", name: "USD/CHF" },
      { market: "stock", symbol: "EURCHF=X", name: "EUR/CHF" },
    ],
  },
  {
    title: "Mega Caps",
    entries: [
      { market: "stock", symbol: "AAPL", name: "Apple" },
      { market: "stock", symbol: "MSFT", name: "Microsoft" },
      { market: "stock", symbol: "NVDA", name: "NVIDIA" },
      { market: "stock", symbol: "GOOGL", name: "Alphabet" },
      { market: "stock", symbol: "AMZN", name: "Amazon" },
      { market: "stock", symbol: "META", name: "Meta" },
      { market: "stock", symbol: "TSLA", name: "Tesla" },
    ],
  },
  {
    title: "Anleihen / Vola",
    entries: [
      { market: "stock", symbol: "^TNX", name: "US 10Y Rendite" },
      { market: "stock", symbol: "^FVX", name: "US 5Y Rendite" },
      { market: "stock", symbol: "^VIX", name: "VIX Volatilität" },
    ],
  },
];

const ALL_ENTRIES = PANELS.flatMap((p) => p.entries);

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
      <table className="w-full text-xs font-mono [font-variant-numeric:tabular-nums]">
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
      </table>
    </section>
  );
}

export default function Monitor() {
  const [quotes, setQuotes] = useState(null); // null until first load → skeletons
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const navigate = useNavigate();
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const map = await fetchQuotes(ALL_ENTRIES);
      if (!aliveRef.current) return;
      setQuotes(map);
      setUpdatedAt(new Date());
    } catch {
      // fetchQuotes tolerates per-symbol failures; on a total failure we keep
      // the previous data on screen instead of blanking the page.
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    load();
    const id = setInterval(load, 60_000);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [load]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Marktübersicht</p>
          <h1 className="text-2xl font-bold">Monitor</h1>
        </div>
        <div className="flex items-center gap-3">
          {updatedAt && (
            <span className="text-xs text-dim font-mono">
              Stand: {updatedAt.toLocaleTimeString("de-CH", { hour12: false })}
            </span>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-line lg-glass px-3 py-1.5 text-xs text-dim hover:text-text hover:border-accent/40 transition-colors disabled:opacity-60"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            Aktualisieren
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
