import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trash2, Plus, Star } from "lucide-react";
import SymbolSearch from "@/components/SymbolSearch";
import { MARKETS } from "@/lib/data";
import { fetchQuotes } from "@/lib/quotes";
import { searchSymbols } from "@/lib/search";
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  subscribe,
} from "@/lib/portfolio";
import { cn, fmtPrice, fmtPct, altName } from "@/lib/utils";

const REFRESH_MS = 30_000;

// SymbolSearch only hands back a ticker string — resolve a display name from the
// search index so stored entries carry something human. Falls back to the raw
// ticker if the lookup misses or fails.
async function resolveName(market, symbol) {
  try {
    const results = await searchSymbols(symbol, market);
    const hit = results.find(
      (r) => r.symbol.toUpperCase() === symbol.toUpperCase()
    );
    return hit?.name || symbol.toUpperCase();
  } catch {
    return symbol.toUpperCase();
  }
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

export default function Watchlist() {
  const navigate = useNavigate();
  const [items, setItems] = useState(() => getWatchlist());
  const [market, setMarket] = useState("crypto");
  const [quotes, setQuotes] = useState({}); // "market:SYMBOL" → { price, changePct }
  const [firstLoad, setFirstLoad] = useState(true);

  // Keep the list in sync with the store (this tab's mutations + other tabs).
  useEffect(() => subscribe(() => setItems(getWatchlist())), []);

  // Live quotes, refreshed on an interval. Keyed on the current symbol set so a
  // fresh add fetches immediately.
  const symbolKey = useMemo(
    () => items.map((i) => `${i.market}:${i.symbol}`).join(","),
    [items]
  );

  useEffect(() => {
    if (items.length === 0) {
      setQuotes({});
      setFirstLoad(false);
      return;
    }
    let alive = true;
    const load = async () => {
      const map = await fetchQuotes(items);
      if (!alive) return;
      const next = {};
      for (const [, v] of map) next[`${v.market}:${v.symbol}`] = v;
      setQuotes(next);
      setFirstLoad(false);
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolKey]);

  const handleAdd = useCallback(
    async (symbol) => {
      const sym = symbol.toUpperCase();
      const name = await resolveName(market, sym);
      addToWatchlist({ market, symbol: sym, name });
    },
    [market]
  );

  const handleRemove = (e) => removeFromWatchlist(e.market, e.symbol);

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Watchlist</p>
      <h1 className="text-2xl font-bold mb-6">Watchlist</h1>

      {/* Add row */}
      <div className="rounded-xl border border-line lg-glass p-4 mb-6">
        <p className="text-xs text-dim font-medium mb-3">Add symbol</p>
        <div className="flex flex-wrap items-center gap-2">
          <MarketToggle market={market} onChange={setMarket} />
          <SymbolSearch
            market={market}
            value=""
            onSelect={handleAdd}
            placeholder={market === "crypto" ? "e.g. BTCUSDT" : "e.g. AAPL, SPY"}
            className="flex-1 min-w-[200px]"
          />
        </div>
      </div>

      {firstLoad && items.length > 0 ? (
        <div className="rounded-xl border border-line lg-glass overflow-hidden">
          <div className="animate-pulse divide-y divide-line/40">
            {Array.from({ length: Math.min(items.length, 5) }).map((_, i) => (
              <div key={i} className="h-12 bg-line/10" />
            ))}
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-line lg-glass p-10 text-center">
          <Star className="w-8 h-8 text-dim mx-auto mb-3" />
          <p className="font-semibold mb-1">No symbols watched yet</p>
          <p className="text-sm text-dim max-w-md mx-auto">
            Add cryptocurrencies or stocks above to keep an eye on prices and daily
            change. Click a row to open the chart.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-line lg-glass overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-dim text-xs border-b border-line">
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="px-4 py-3 font-medium hidden sm:table-cell">Market</th>
                  <th className="px-4 py-3 font-medium text-right">Price</th>
                  <th className="px-4 py-3 font-medium text-right">1D</th>
                  <th className="px-4 py-3 font-medium text-right w-10" />
                </tr>
              </thead>
              <tbody>
                {items.map((w) => {
                  const q = quotes[`${w.market}:${w.symbol}`];
                  const pct = q?.changePct;
                  const hasPct = pct != null && Number.isFinite(pct);
                  return (
                    <tr
                      key={`${w.market}:${w.symbol}`}
                      onClick={() =>
                        navigate(`/charts?market=${w.market}&symbol=${w.symbol}`)
                      }
                      className="border-b border-line/50 last:border-0 hover:bg-bg/60 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono font-semibold">{w.symbol}</span>
                        {altName(w.symbol, w.name) && <span className="text-dim ml-2 hidden md:inline">{altName(w.symbol, w.name)}</span>}
                      </td>
                      <td className="px-4 py-3 text-dim hidden sm:table-cell">
                        {w.market === "crypto" ? "Crypto" : "Stocks"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {q ? fmtPrice(q.price) : <span className="text-dim">…</span>}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-3 text-right font-mono",
                          hasPct && pct > 0 && "text-up",
                          hasPct && pct < 0 && "text-down",
                          !hasPct && "text-dim"
                        )}
                      >
                        {hasPct ? (
                          <>
                            {pct > 0 ? "▲" : pct < 0 ? "▼" : ""} {fmtPct(pct)}
                          </>
                        ) : q ? (
                          "–"
                        ) : (
                          "…"
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemove(w);
                          }}
                          title="Remove"
                          className="text-dim hover:text-down transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-dim mt-4 flex items-center gap-1.5">
        <Plus className="w-3 h-3" /> Prices refresh automatically every 60 seconds.
      </p>
    </div>
  );
}
