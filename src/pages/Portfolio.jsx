import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, Pencil, Check, X, Wallet, Plus, BadgeDollarSign, RotateCcw, DownloadCloud, Loader2, Banknote } from "lucide-react";
import SymbolSearch from "@/components/SymbolSearch";
import { MARKETS, fetchCandles } from "@/lib/data";
import { fetchQuotes } from "@/lib/quotes";
import { hrpWeights } from "@/lib/hrp";
import { searchSymbols } from "@/lib/search";
import {
  getPortfolio,
  addPosition,
  updatePosition,
  sellShares,
  removePosition,
  subscribe,
  isClosed,
  getDeposits,
  addDeposit,
  removeDeposit,
  cashUSD,
} from "@/lib/portfolio";
import { fxRateToUSD, DEPOSIT_CURRENCIES } from "@/lib/fx";
import { ibkrActive, fetchIbkrPositions } from "@/lib/ibkr";
import { cn, fmtNum, fmtPrice, fmtPct } from "@/lib/utils";
import { computeHoldings, ageLabel } from "@/lib/portfolioTotals";

const REFRESH_MS = 30_000;

// Local-timezone YYYY-MM-DD for <input type="date"> defaults.
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–";

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
  const [deposits, setDeposits] = useState(() => getDeposits());
  const [quotes, setQuotes] = useState({}); // "market:SYMBOL" → { price, changePct }
  const [firstLoad, setFirstLoad] = useState(true);

  // Deposit form (cash model: account is kept in USD, FX frozen at deposit date)
  const [depositAmount, setDepositAmount] = useState("");
  const [depositCurrency, setDepositCurrency] = useState("CHF");
  const [depositDate, setDepositDate] = useState(todayStr);
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositErr, setDepositErr] = useState("");
  const [showDeposits, setShowDeposits] = useState(false);

  // Add form
  const [market, setMarket] = useState("crypto");
  const [symbol, setSymbol] = useState("");
  const [shares, setShares] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const [buyDate, setBuyDate] = useState(todayStr);
  const [submitting, setSubmitting] = useState(false);

  // Inline editing
  const [editId, setEditId] = useState(null);
  const [editShares, setEditShares] = useState("");
  const [editAvg, setEditAvg] = useState("");
  const [editBuyDate, setEditBuyDate] = useState("");

  // Sell flow (inline panel under the row)
  const [sellId, setSellId] = useState(null);
  const [sellPrice, setSellPrice] = useState("");
  const [sellDate, setSellDate] = useState(todayStr);
  const [sellQty, setSellQty] = useState("");

  // IBKR import (read-only; only shown when the gateway feature is enabled)
  const [canIbkr] = useState(ibkrActive);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");

  useEffect(
    () =>
      subscribe(() => {
        setPositions(getPortfolio());
        setDeposits(getDeposits());
      }),
    []
  );

  // Only OPEN positions need live quotes — closed ones are frozen at the sale.
  const openPositions = useMemo(() => positions.filter((p) => !isClosed(p)), [positions]);

  // ── HRP suggested allocation (López de Prado / Jansen) ────────────────────
  // Clusters the open book by return correlation and splits risk down the tree
  // — a diversified, stable target to compare the current weights against.
  const [hrp, setHrp] = useState(null);
  const [hrpStatus, setHrpStatus] = useState(null);
  const computeHrp = async () => {
    if (hrpStatus) return;
    setHrp(null);
    const syms = [...new Map(openPositions.map((p) => [`${p.market}:${p.symbol}`, p])).values()];
    if (syms.length < 2) { setHrpStatus(null); setHrp({ error: "Need at least 2 open positions." }); return; }
    setHrpStatus("Loading history…");
    try {
      const returnsBySym = {};
      for (const p of syms) {
        const candles = await fetchCandles({ market: p.market, symbol: p.symbol, interval: "1d", range: "2y" });
        const c = candles.map((x) => x.close).filter((x) => x > 0);
        if (c.length < 60) continue;
        const r = [];
        for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
        returnsBySym[p.symbol] = r;
      }
      if (Object.keys(returnsBySym).length < 2) { setHrp({ error: "Not enough price history for these symbols." }); return; }
      setHrpStatus("Clustering & allocating…");
      const { weights } = hrpWeights(returnsBySym);
      setHrp({ weights });
    } catch (e) {
      setHrp({ error: String(e.message || e).slice(0, 120) });
    } finally {
      setHrpStatus(null);
    }
  };
  const symbolKey = useMemo(
    () => openPositions.map((p) => `${p.market}:${p.symbol}`).join(","),
    [openPositions]
  );

  useEffect(() => {
    if (openPositions.length === 0) {
      setQuotes({});
      setFirstLoad(false);
      return;
    }
    let alive = true;
    const load = async () => {
      const map = await fetchQuotes(openPositions, { keepStale: true });
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
  // A position without a current quote is shown (last price + age) but left out
  // of the totals — see lib/portfolioTotals.js for why.
  const { rows, totals } = useMemo(
    () => computeHoldings(positions, quotes, isClosed),
    [positions, quotes]
  );

  // ── Cash (derived: deposits − buys + realized sells, all USD) ─────────────
  const cash = useMemo(() => cashUSD(positions, deposits), [positions, deposits]);
  const accountValue = cash + totals.totalValue;

  const handleDeposit = async () => {
    const amt = Number(String(depositAmount).replace(",", "."));
    if (!(amt > 0) || depositBusy) return;
    setDepositBusy(true);
    setDepositErr("");
    try {
      const rate = await fxRateToUSD(depositCurrency, depositDate);
      addDeposit({ amount: amt, currency: depositCurrency, date: depositDate, rate, usd: amt * rate });
      setDepositAmount("");
    } catch (e) {
      setDepositErr(String(e?.message || e));
    } finally {
      setDepositBusy(false);
    }
  };

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
      addPosition({ market, symbol: sym, name, shares, avgPrice: entryPrice, buyDate });
      setSymbol("");
      setShares("");
      setAvgPrice("");
      setBuyDate(todayStr());
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (r) => {
    setEditId(r.id);
    setEditShares(String(r.shares));
    setEditAvg(String(r.avgPrice));
    const d = r.buyDate ?? r.addedAt;
    setEditBuyDate(d ? new Date(d).toISOString().slice(0, 10) : todayStr());
  };

  const saveEdit = (id) => {
    updatePosition(id, { shares: editShares, avgPrice: editAvg, buyDate: editBuyDate });
    setEditId(null);
  };

  // ── Sell / reopen ──────────────────────────────────────────────────────────
  const startSell = (r) => {
    setSellId(r.id);
    setSellPrice(r.price != null ? String(r.price) : "");
    setSellDate(todayStr());
    setSellQty(String(r.shares));   // default to the whole lot — the old behaviour
  };

  const num = (v) => Number(String(v).replace(",", "."));

  const confirmSell = (id, held) => {
    const sp = num(sellPrice);
    const qty = num(sellQty);
    if (!Number.isFinite(sp) || sp <= 0) return;
    if (!Number.isFinite(qty) || qty <= 0 || qty > held + 1e-9) return;
    // sellShares splits the lot for a partial sale and closes it outright for a
    // full one, so the existing full-close path is unchanged.
    sellShares(id, { shares: qty, price: sp, date: sellDate });
    setSellId(null);
  };

  const reopen = (id) => updatePosition(id, { sellPrice: null });

  // ── IBKR import (READ-ONLY: positions are fetched, never orders placed) ────
  const importIbkr = async () => {
    setImporting(true);
    setImportMsg("");
    try {
      const ib = await fetchIbkrPositions();
      if (!ib.length) { setImportMsg("No stock positions found on the gateway."); return; }
      let added = 0, updated = 0;
      const cur = getPortfolio();
      for (const pos of ib) {
        const existing = cur.find((p) => p.market === "stock" && p.symbol === pos.symbol && !isClosed(p));
        if (existing) {
          if (existing.shares !== pos.shares || (pos.avgPrice > 0 && existing.avgPrice !== pos.avgPrice)) {
            updatePosition(existing.id, { shares: pos.shares, avgPrice: pos.avgPrice > 0 ? pos.avgPrice : existing.avgPrice });
            updated++;
          }
        } else {
          addPosition({ market: "stock", symbol: pos.symbol, name: pos.name, shares: pos.shares, avgPrice: pos.avgPrice });
          added++;
        }
      }
      setImportMsg(`IBKR sync: ${added} added, ${updated} updated. Buy dates default to today — edit them so the equity graph is right.`);
    } catch (e) {
      setImportMsg(`IBKR import failed: ${e?.message || "gateway unreachable"}`);
    } finally {
      setImporting(false);
    }
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

      {totals.excludedCount > 0 && (
        <div className="rounded-xl border border-warn/40 bg-warn/5 px-4 py-2.5 mb-3 text-[12px] leading-relaxed text-warn">
          {totals.excludedCount} position{totals.excludedCount === 1 ? "" : "s"} without a current quote
          ({totals.excludedSymbols.slice(0, 8).join(", ")}{totals.excludedCount > 8 ? "…" : ""}) {totals.excludedCount === 1 ? "is" : "are"} left
          out of value, invested and P/L below
          {totals.excludedStaleValue > 0 ? ` (last known value ${fmtNum(totals.excludedStaleValue, 2)} USD)` : ""}.
          {" "}{totals.excludedCount === 1 ? "It rejoins" : "They rejoin"} the totals on the next successful refresh.
        </div>
      )}

      {/* Summary */}
      <div className={cn("grid grid-cols-2 gap-3 mb-6", totals.hasClosed ? "lg:grid-cols-6" : "lg:grid-cols-5")}>
        <SummaryCard
          label="Account value · USD"
          value={fmtNum(accountValue, 2)}
          sub={`positions ${fmtNum(totals.totalValue, 2)}${totals.excludedCount ? ` · excl. ${totals.excludedCount} stale` : ""}`}
          big
        />
        <SummaryCard
          label="Cash · USD"
          value={fmtNum(cash, 2)}
          sub={deposits.length ? `${deposits.length} deposit${deposits.length === 1 ? "" : "s"}` : "no deposits yet"}
          tone={cash < 0 ? "text-down" : "text-text"}
          big
        />
        <SummaryCard
          label="Invested"
          value={fmtNum(totals.totalCost, 2)}
          sub={`${totals.count} position${totals.count === 1 ? "" : "s"}`}
          big
        />
        <SummaryCard
          label="Today's P/L"
          value={totals.dayHasData ? (totals.dayPnl >= 0 ? "+" : "") + fmtNum(totals.dayPnl, 2) : "–"}
          sub={totals.dayPnlPct != null ? fmtPct(totals.dayPnlPct) : null}
          tone={totals.dayHasData ? upDown(totals.dayPnl) : "text-dim"}
          big
        />
        <SummaryCard
          label="Total P/L"
          value={(totals.totalPnl >= 0 ? "+" : "") + fmtNum(totals.totalPnl, 2)}
          sub={gvSub}
          tone={upDown(totals.totalPnl)}
          big
        />
        {totals.hasClosed && (
          <SummaryCard
            label="Realized P/L"
            value={(totals.realizedPnl >= 0 ? "+" : "") + fmtNum(totals.realizedPnl, 2)}
            sub={totals.realizedPct != null ? fmtPct(totals.realizedPct) : null}
            tone={upDown(totals.realizedPnl)}
            big
          />
        )}
      </div>

      {/* Cash & deposits */}
      <div className="rounded-xl border border-line lg-glass p-4 mb-6">
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className="text-xs text-dim font-medium flex items-center gap-1.5">
            <Banknote className="w-3.5 h-3.5" /> Cash &amp; deposits
          </p>
          {deposits.length > 0 && (
            <button
              type="button"
              onClick={() => setShowDeposits((v) => !v)}
              className="chip chip-idle !text-[11px]"
            >
              {showDeposits ? "Hide history" : `History (${deposits.length})`}
            </button>
          )}
        </div>
        <p className="text-[11px] text-dim mb-3 leading-relaxed">
          Fund the account in any currency — it's converted to USD at the ECB daily rate of the
          chosen date and the account runs in USD from there. Buys deduct cash, sales add the
          proceeds back.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-dim">
            Amount
            <input
              type="number"
              min={0}
              step="any"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="0"
              className="input-base w-32 mt-1 font-mono block"
            />
          </label>
          <label className="text-xs text-dim">
            Currency
            <select
              value={depositCurrency}
              onChange={(e) => setDepositCurrency(e.target.value)}
              className="input-base w-24 mt-1 font-mono block"
            >
              {DEPOSIT_CURRENCIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-dim">
            Date
            <input
              type="date"
              value={depositDate}
              max={todayStr()}
              onChange={(e) => setDepositDate(e.target.value)}
              className="input-base w-36 mt-1 font-mono block"
            />
          </label>
          <button
            type="button"
            onClick={handleDeposit}
            disabled={!(Number(String(depositAmount).replace(",", ".")) > 0) || depositBusy}
            className="btn-accent flex items-center gap-1.5 disabled:opacity-40"
          >
            {depositBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Deposit
          </button>
        </div>
        {depositErr && <p className="text-[11px] text-down mt-2">{depositErr}</p>}
        {cash < 0 && (
          <p className="text-[11px] text-down mt-2">
            Cash is negative — your buys exceed your deposits. Add a deposit (dated before the
            buys, if you like) to cover them.
          </p>
        )}
        {showDeposits && deposits.length > 0 && (
          <div className="mt-3 space-y-1">
            <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-4 text-[10px] uppercase tracking-wider text-dim">
              <span>Date</span><span>Deposit</span><span className="text-right">Rate</span><span className="text-right">USD</span><span />
            </div>
            {[...deposits]
              .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.addedAt || 0) - (a.addedAt || 0))
              .map((d) => (
                <div key={d.id} className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-4 items-center text-xs font-mono">
                  <span className="text-dim">{d.date}</span>
                  <span>{fmtNum(d.amount, 2)} {d.currency}</span>
                  <span className="text-right text-dim">{d.currency === "USD" ? "–" : fmtNum(d.rate, 4)}</span>
                  <span className="text-right font-semibold">{fmtNum(d.usd, 2)}</span>
                  <button
                    onClick={() => removeDeposit(d.id)}
                    title="Remove deposit"
                    className="text-dim hover:text-down transition-colors justify-self-end"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* HRP suggested allocation */}
      {openPositions.length >= 2 && (
        <div className="rounded-xl border border-line lg-glass p-4 mb-6">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="text-xs text-dim font-medium">Suggested allocation · HRP</p>
            <button onClick={computeHrp} disabled={!!hrpStatus}
              className="chip chip-idle flex items-center gap-1.5 !text-[11px] disabled:opacity-50">
              {hrpStatus ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {hrpStatus || "Compute"}
            </button>
          </div>
          <p className="text-[11px] text-dim mb-3 leading-relaxed">
            Hierarchical Risk Parity clusters your book by return correlation and splits risk down
            the tree — a diversified target that doesn't invert a covariance matrix. Two years of
            daily history. Educational, not advice.
          </p>
          {hrp?.error && <p className="text-xs text-down">{hrp.error}</p>}
          {hrp?.weights && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 text-[10px] uppercase tracking-wider text-dim">
                <span>Symbol</span><span className="text-right">Current</span><span className="text-right">HRP</span><span className="text-right">Δ</span>
              </div>
              {(() => {
                const curBySym = {};
                for (const r of rows) if (!r.closed && r.allocPct != null) curBySym[r.symbol] = r.allocPct;
                return Object.entries(hrp.weights)
                  .sort((a, b) => b[1] - a[1])
                  .map(([sym, w]) => {
                    const cur = curBySym[sym] ?? 0, tgt = w * 100, d = tgt - cur;
                    return (
                      <div key={sym} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 items-center text-xs font-mono">
                        <span className="truncate">{sym}</span>
                        <span className="text-right text-dim">{cur.toFixed(1)}%</span>
                        <span className="text-right font-semibold">{tgt.toFixed(1)}%</span>
                        <span className={cn("text-right", Math.abs(d) < 1 ? "text-dim" : d > 0 ? "text-up" : "text-down")}>
                          {d >= 0 ? "+" : ""}{d.toFixed(1)}
                        </span>
                      </div>
                    );
                  });
              })()}
            </div>
          )}
        </div>
      )}

      {/* Add form */}
      <div className="rounded-xl border border-line lg-glass p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-dim font-medium">Add position</p>
          {canIbkr && (
            <button
              type="button"
              onClick={importIbkr}
              disabled={importing}
              title="Read your current stock positions from the local IBKR gateway (read-only — never places orders)"
              className="chip chip-idle flex items-center gap-1.5 !text-[11px]"
            >
              {importing ? <Loader2 className="w-3 h-3 animate-spin" /> : <DownloadCloud className="w-3 h-3" />}
              Import from IBKR
            </button>
          )}
        </div>
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
          <label className="text-xs text-dim">
            Buy date
            <input
              type="date"
              value={buyDate}
              max={todayStr()}
              onChange={(e) => setBuyDate(e.target.value)}
              className="input-base w-36 mt-1 font-mono block"
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
          Leave buy price empty → the current price is used as the entry. The buy date controls when the
          position enters the Dashboard equity graph.
        </p>
        {importMsg && <p className="text-[11px] text-accent mt-1">{importMsg}</p>}
      </div>

      {/* Holdings */}
      {firstLoad && positions.length > 0 ? (
        <div className="rounded-xl border border-line lg-glass overflow-hidden">
          <div className="divide-y divide-line/40">
            {Array.from({ length: Math.min(positions.length, 5) }).map((_, i) => (
              <div key={i} className="h-12 skeleton !rounded-none" />
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
                  const selling = sellId === r.id;
                  return (
                    <Fragment key={r.id}>
                    <tr
                      className={cn(
                        "border-b border-line/50 last:border-0 hover:bg-bg/40 transition-colors",
                        r.closed && "opacity-60"
                      )}
                    >
                      <td className="px-4 py-3">
                        <span className="font-mono font-semibold">{r.symbol}</span>
                        {r.closed && (
                          <span className="ml-2 text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5 font-semibold bg-line/60 text-dim">
                            sold {fmtDate(r.sellDate)}
                          </span>
                        )}
                        <span className="text-dim ml-2 hidden md:inline">{r.name}</span>
                        <span className="block text-[10px] text-dim mt-0.5">
                          bought {fmtDate(r.buyDate ?? r.addedAt)}
                        </span>
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
                          <div className="space-y-1">
                            <input
                              type="number"
                              min={0}
                              step="any"
                              value={editAvg}
                              onChange={(e) => setEditAvg(e.target.value)}
                              className="input-base w-24 font-mono text-right py-1"
                            />
                            <input
                              type="date"
                              value={editBuyDate}
                              max={todayStr()}
                              onChange={(e) => setEditBuyDate(e.target.value)}
                              title="Buy date"
                              className="input-base w-32 font-mono text-right py-1 text-xs"
                            />
                          </div>
                        ) : (
                          fmtPrice(r.avgPrice)
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {r.price != null ? (
                          <span className={r.stale && !r.closed ? "text-dim" : undefined}>{fmtPrice(r.price)}</span>
                        ) : <span className="text-dim">–</span>}
                        {r.stale && !r.closed && (
                          <div className="text-[10px] text-warn" title="This quote failed to refresh. The position is left out of the totals until it does.">
                            {r.price != null ? `stale · ${ageLabel(r.asOf) ?? "age unknown"}` : "no quote"}
                          </div>
                        )}
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
                              {r.closed ? (
                                <button
                                  onClick={() => reopen(r.id)}
                                  title="Reopen (undo sale)"
                                  className="text-dim hover:text-accent transition-colors"
                                >
                                  <RotateCcw className="w-4 h-4" />
                                </button>
                              ) : (
                                <button
                                  onClick={() => startSell(r)}
                                  title="Sell — record the sale price"
                                  className="text-dim hover:text-up transition-colors"
                                >
                                  <BadgeDollarSign className="w-4 h-4" />
                                </button>
                              )}
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
                    {selling && (
                      <tr className="border-b border-line/50 bg-bg/40">
                        <td colSpan={8} className="px-4 py-3">
                          <div className="flex flex-wrap items-end gap-3">
                            <span className="text-xs text-dim self-center">
                              Sell <span className="font-mono font-semibold text-text">{r.symbol}</span> — realized P/L is locked in on the shares you sell:
                            </span>
                            <label className="text-xs text-dim">
                              Shares
                              <span className="text-dim"> of {fmtNum(r.shares, 4)}</span>
                              <input
                                type="number"
                                min={0}
                                max={r.shares}
                                step="any"
                                value={sellQty}
                                onChange={(e) => setSellQty(e.target.value)}
                                className="input-base w-28 mt-1 font-mono block"
                              />
                            </label>
                            <div className="flex gap-1 self-end pb-1">
                              {[0.25, 0.5, 1].map((f) => (
                                <button key={f} type="button"
                                  onClick={() => setSellQty(String(+(r.shares * f).toFixed(8)))}
                                  className="chip chip-idle text-[11px]">
                                  {f === 1 ? "All" : `${f * 100}%`}
                                </button>
                              ))}
                            </div>
                            <label className="text-xs text-dim">
                              Sell price
                              <input
                                type="number"
                                min={0}
                                step="any"
                                value={sellPrice}
                                onChange={(e) => setSellPrice(e.target.value)}
                                placeholder="current"
                                className="input-base w-28 mt-1 font-mono block"
                                autoFocus
                              />
                            </label>
                            <label className="text-xs text-dim">
                              Sell date
                              <input
                                type="date"
                                value={sellDate}
                                max={todayStr()}
                                onChange={(e) => setSellDate(e.target.value)}
                                className="input-base w-36 mt-1 font-mono block"
                              />
                            </label>
                            <button
                              onClick={() => confirmSell(r.id, r.shares)}
                              disabled={!(num(sellPrice) > 0) || !(num(sellQty) > 0) || num(sellQty) > r.shares + 1e-9}
                              className="btn-accent flex items-center gap-1.5 disabled:opacity-40"
                            >
                              <Check className="w-4 h-4" />
                              {num(sellQty) > 0 && num(sellQty) < r.shares ? "Sell part" : "Confirm sale"}
                            </button>
                            <button onClick={() => setSellId(null)} className="chip chip-idle">
                              Cancel
                            </button>
                            {num(sellPrice) > 0 && num(sellQty) > 0 && (() => {
                              const qty = Math.min(num(sellQty), r.shares);
                              const v = qty * (num(sellPrice) - r.avgPrice);
                              const left = r.shares - qty;
                              return (
                                <span className="text-xs font-mono self-center">
                                  <span className={upDown(v)}>realized: {(v >= 0 ? "+" : "") + fmtNum(v, 2)}</span>
                                  {left > 1e-9 && (
                                    <span className="text-dim"> · {fmtNum(left, 4)} shares stay open</span>
                                  )}
                                </span>
                              );
                            })()}
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-dim mt-4">
        Prices &amp; today's P/L refresh automatically every 30 seconds. Simulated
        portfolio — not real money, not investment advice.
      </p>
    </div>
  );
}
