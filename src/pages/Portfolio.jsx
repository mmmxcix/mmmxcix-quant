import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, Pencil, Check, X, Wallet, Plus } from "lucide-react";
import SymbolSearch from "@/components/SymbolSearch";
import { MARKETS } from "@/lib/data";
import { fetchQuotes } from "@/lib/quotes";
import { searchSymbols } from "@/lib/search";
import {
  getPortfolio,
  addPosition,
  updatePosition,
  removePosition,
  subscribe,
} from "@/lib/portfolio";
import { cn, fmtNum, fmtPrice, fmtPct } from "@/lib/utils";

const REFRESH_MS = 30_000;

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

function upDown(n) {
  if (n == null || !Number.isFinite(n) || n === 0) return "text-dim";
  return n > 0 ? "text-up" : "text-down";
}

function MarketToggle({ market, onChange }) {
  return (
    <div className="flex gap-1">
      {MARKETS.map((mk) => (
        <button
          key={mk.id}
          type="button"
          onClick={() => onChange(mk.id)}
          className={cn("chip", market === mk.id ? "chip-active" : "chip-idle")}
        >
          {mk.label}
        </button>
      ))}
    </div>
  );
}

function SummaryCard({ label, value, sub, tone = "text-text", big = false }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3">
      <p className="text-[11px] text-dim mb-1">{label}</p>
      <p className={cn("font-mono font-semibold", big ? "text-lg" : "", tone)}>{value}</p>
      {sub != null && <p className={cn("text-xs font-mono mt-0.5", tone)}>{sub}</p>}
    </div>
  );
}

export default function Portfolio() {
  const [positions, setPositions] = useState(() => getPortfolio());
  const [quotes, setQuotes] = useState({}); // "market:SYMBOL" → { price, changePct }
  const [firstLoad, setFirstLoad] = useState(true);

  // Add form
  const [market, setMarket] = useState("crypto");
  const [symbol, setSymbol] = useState("");
  const [shares, setShares] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Inline editing
  const [editId, setEditId] = useState(null);
  const [editShares, setEditShares] = useState("");
  const [editAvg, setEditAvg] = useState("");

  useEffect(() => subscribe(() => setPositions(getPortfolio())), []);

  const symbolKey = useMemo(
    () => positions.map((p) => `${p.market}:${p.symbol}`).join(","),
    [positions]
  );

  useEffect(() => {
    if (positions.length === 0) {
      setQuotes({});
      setFirstLoad(false);
      return;
    }
    let alive = true;
    const load = async () => {
      const map = await fetchQuotes(positions);
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

  const priceOf = useCallback(
    (p) => {
      const q = quotes[`${p.market}:${p.symbol}`];
      return q && Number.isFinite(q.price) ? q.price : null;
    },
    [quotes]
  );

  // ── Derived rows + totals ──────────────────────────────────────────────────
  const { rows, totals } = useMemo(() => {
    const computed = positions.map((p) => {
      const price = priceOf(p);
      const cost = p.shares * p.avgPrice;
      const value = price != null ? p.shares * price : null;
      const pnl = value != null ? value - cost : null;
      const pnlPct = value != null && cost > 0 ? (pnl / cost) * 100 : null;
      return { ...p, price, cost, value, pnl, pnlPct };
    });
    const totalValue = computed.reduce((s, r) => s + (r.value ?? 0), 0);
    const totalCost = computed.reduce((s, r) => s + (r.cost || 0), 0);
    const totalPnl = totalValue - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : null;
    // Allocation is % of current total value (only positions with a known price).
    const withAlloc = computed.map((r) => ({
      ...r,
      allocPct: r.value != null && totalValue > 0 ? (r.value / totalValue) * 100 : null,
    }));
    return {
      rows: withAlloc,
      totals: { totalValue, totalCost, totalPnl, totalPnlPct, count: computed.length },
    };
  }, [positions, priceOf]);

  // ── Add ────────────────────────────────────────────────────────────────────
  const canSubmit = symbol.trim() !== "" && Number(String(shares).replace(",", ".")) > 0;

  const handleAdd = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const sym = symbol.trim().toUpperCase();
      const name = await resolveName(market, sym);
      let entryPrice = Number(String(avgPrice).replace(",", "."));
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        // No entry price given → use the current market price as cost basis.
        const map = await fetchQuotes([{ market, symbol: sym, name }]);
        const q = map.get(sym);
        entryPrice = q && Number.isFinite(q.price) ? q.price : 0;
      }
      addPosition({ market, symbol: sym, name, shares, avgPrice: entryPrice });
      setSymbol("");
      setShares("");
      setAvgPrice("");
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (r) => {
    setEditId(r.id);
    setEditShares(String(r.shares));
    setEditAvg(String(r.avgPrice));
  };

  const saveEdit = (id) => {
    updatePosition(id, { shares: editShares, avgPrice: editAvg });
    setEditId(null);
  };

  const gvSub =
    totals.totalPnlPct != null ? fmtPct(totals.totalPnlPct) : "–";

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Simulation</p>
      <h1 className="text-2xl font-bold mb-2">Portfolio</h1>
      <p className="text-sm text-dim mb-6">
        Simulated portfolio — not real money, not investment advice.
      </p>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <SummaryCard label="Total value" value={fmtNum(totals.totalValue, 2)} big />
        <SummaryCard label="Invested" value={fmtNum(totals.totalCost, 2)} big />
        <SummaryCard
          label="Total P/L"
          value={(totals.totalPnl >= 0 ? "+" : "") + fmtNum(totals.totalPnl, 2)}
          sub={gvSub}
          tone={upDown(totals.totalPnl)}
          big
        />
        <SummaryCard label="Positions" value={String(totals.count)} big />
      </div>

      {/* Add form */}
      <div className="rounded-xl border border-line lg-glass p-4 mb-6">
        <p className="text-xs text-dim uppercase tracking-widest mb-3">Add position</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <MarketToggle
              market={market}
              onChange={(m) => {
                setMarket(m);
                setSymbol("");
              }}
            />
            <SymbolSearch
              market={market}
              value={symbol}
              onSelect={(s) => setSymbol(s.toUpperCase())}
              placeholder={market === "crypto" ? "e.g. BTCUSDT" : "e.g. AAPL"}
              className="w-56"
            />
          </div>
          <label className="text-xs text-dim">
            Quantity / shares
            <input
              type="number"
              min={0}
              step="any"
              value={shares}
              onChange={(e) => setShares(e.target.value)}
              placeholder="0"
              className="input-base w-28 mt-1 font-mono block"
            />
          </label>
          <label className="text-xs text-dim">
            Buy price (avg.)
            <input
              type="number"
              min={0}
              step="any"
              value={avgPrice}
              onChange={(e) => setAvgPrice(e.target.value)}
              placeholder="current"
              className="input-base w-32 mt-1 font-mono block"
            />
          </label>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!canSubmit || submitting}
            className="btn-accent flex items-center gap-1.5 disabled:opacity-40"
          >
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
        <p className="text-[11px] text-dim mt-2">
          Leave buy price empty → the current price is used as the entry.
        </p>
      </div>

      {/* Holdings */}
      {firstLoad && positions.length > 0 ? (
        <div className="rounded-xl border border-line lg-glass overflow-hidden">
          <div className="animate-pulse divide-y divide-line/40">
            {Array.from({ length: Math.min(positions.length, 5) }).map((_, i) => (
              <div key={i} className="h-12 bg-line/10" />
            ))}
          </div>
        </div>
      ) : positions.length === 0 ? (
        <div className="rounded-xl border border-line lg-glass p-10 text-center">
          <Wallet className="w-8 h-8 text-dim mx-auto mb-3" />
          <p className="font-semibold mb-1">No positions yet</p>
          <p className="text-sm text-dim max-w-md mx-auto">
            Add a simulated position above to track value and profit/loss in real
            time. For practice only — no real money is involved.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-line lg-glass overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-dim text-xs border-b border-line">
                  <th className="px-4 py-3 font-medium">Symbol</th>
                  <th className="px-4 py-3 font-medium text-right">Quantity</th>
                  <th className="px-4 py-3 font-medium text-right">Avg. buy price</th>
                  <th className="px-4 py-3 font-medium text-right">Price</th>
                  <th className="px-4 py-3 font-medium text-right">Value</th>
                  <th className="px-4 py-3 font-medium text-right">P/L</th>
                  <th className="px-4 py-3 font-medium hidden lg:table-cell w-40">Weight</th>
                  <th className="px-4 py-3 font-medium text-right w-20" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const editing = editId === r.id;
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-line/50 last:border-0 hover:bg-bg/40 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono font-semibold">{r.symbol}</span>
                        <span className="text-dim ml-2 hidden md:inline">{r.name}</span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {editing ? (
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={editShares}
                            onChange={(e) => setEditShares(e.target.value)}
                            className="input-base w-24 font-mono text-right py-1"
                          />
                        ) : (
                          fmtNum(r.shares, 4)
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {editing ? (
                          <input
                            type="number"
                            min={0}
                            step="any"
                            value={editAvg}
                            onChange={(e) => setEditAvg(e.target.value)}
                            className="input-base w-24 font-mono text-right py-1"
                          />
                        ) : (
                          fmtPrice(r.avgPrice)
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {r.price != null ? fmtPrice(r.price) : <span className="text-dim">–</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {r.value != null ? fmtNum(r.value, 2) : <span className="text-dim">–</span>}
                      </td>
                      <td className={cn("px-4 py-3 text-right font-mono", upDown(r.pnl))}>
                        {r.pnl != null ? (
                          <>
                            <div>{(r.pnl >= 0 ? "+" : "") + fmtNum(r.pnl, 2)}</div>
                            {r.pnlPct != null && (
                              <div className="text-xs">{fmtPct(r.pnlPct)}</div>
                            )}
                          </>
                        ) : (
                          <span className="text-dim">–</span>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        {r.allocPct != null ? (
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 rounded-sm bg-line/40 overflow-hidden">
                              <div
                                className="h-full rounded-sm bg-accent"
                                style={{ width: `${Math.max(2, Math.min(100, r.allocPct))}%` }}
                              />
                            </div>
                            <span className="text-[11px] text-dim font-mono w-10 text-right shrink-0">
                              {fmtNum(r.allocPct, 1)}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-dim text-xs">–</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {editing ? (
                            <>
                              <button
                                onClick={() => saveEdit(r.id)}
                                title="Save"
                                className="text-dim hover:text-up transition-colors"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => setEditId(null)}
                                title="Cancel"
                                className="text-dim hover:text-text transition-colors"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => startEdit(r)}
                                title="Edit"
                                className="text-dim hover:text-accent transition-colors"
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => removePosition(r.id)}
                                title="Remove"
                                className="text-dim hover:text-down transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-dim mt-4">
        Prices refresh automatically every 60 seconds. Simulated portfolio —
        not real money, not investment advice.
      </p>
    </div>
  );
}
