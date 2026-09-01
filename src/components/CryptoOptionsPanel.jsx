import { useEffect, useMemo, useState } from "react";
import { Loader2, Info } from "lucide-react";
import XYLineChart from "@/components/XYLineChart";
import {
  fetchOptionsOverview, fetchBvolHistory, ILLIQUID_TURNOVER_USDT, OI_MAX_DAYS,
} from "@/lib/binanceOptions";
import { vizColor } from "@/lib/vizColors";
import { cn, fmtNum, fmtPrice } from "@/lib/utils";

// Crypto options (Binance) — the Volatility tab's third view. Three things:
//   1. BVOL, Binance's 30-day implied-vol index for BTC / ETH (the crypto VIX),
//      as a history from the nightly-synced archive (/api/bvol);
//   2. the LIVE term structure and 25-delta skew from the option chain
//      (src/lib/binanceOptions.js, straight from Binance);
//   3. one row per underlying: 30-day ATM IV, put/call ratios, open interest.
// The smaller names are shown but tagged — a P/C ratio on 3k USDT of turnover
// is a curiosity, not a signal, and the page should say so rather than let a
// gold contract that listed last week sit next to BTC as an equal.

const HEADLINE = ["BTCUSDT", "ETHUSDT"];
const BVOL = { BTCUSDT: "BTCBVOLUSDT", ETHUSDT: "ETHBVOLUSDT" };
const LABEL = { BTCUSDT: "BTC", ETHUSDT: "ETH" };
const RANGES = [["1mo", "1M", 30], ["3mo", "3M", 90], ["1y", "1Y", 365], ["max", "All", Infinity]];

const fmtIv = (v) => (v == null ? "–" : `${fmtNum(v * 100, 1)}%`);
const fmtSkew = (v) => (v == null ? "–" : `${v > 0 ? "+" : ""}${fmtNum(v * 100, 1)}`);
const fmtRatio = (v) => (v == null ? "–" : fmtNum(v, 2));
function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${fmtNum(v / 1e9, 2)}B`;
  if (a >= 1e6) return `$${fmtNum(v / 1e6, 1)}M`;
  if (a >= 1e3) return `$${fmtNum(v / 1e3, 1)}k`;
  return `$${fmtNum(v, 0)}`;
}
const fmtDay = (sec, long) =>
  new Date(sec * 1000).toLocaleDateString("en-US", long ? { month: "short", year: "2-digit", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" });

function Stat({ label, value, sub, tone }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3">
      <p className="text-[11px] text-dim mb-1">{label}</p>
      <p className={cn("font-mono font-semibold text-lg", tone || "text-text")}>{value}</p>
      {sub && <p className="text-[11px] text-dim mt-0.5">{sub}</p>}
    </div>
  );
}

// Where the latest BVOL print sits in its own 12-month range — the same "is
// vol high FOR THIS NAME" read the rest of the tab is built on.
function bvolRank(daily) {
  if (!daily?.length) return null;
  const last = daily[daily.length - 1];
  const cutoff = last.time - 365 * 86400;
  const year = daily.filter((d) => d.time >= cutoff).map((d) => d.close);
  if (year.length < 30) return null;
  const lo = Math.min(...year), hi = Math.max(...year);
  return { value: last.close, lo, hi, rank: hi > lo ? ((last.close - lo) / (hi - lo)) * 100 : null };
}

function BvolCard({ series, loading, error }) {
  const [range, setRange] = useState("1y");
  const colors = useMemo(() => ({ BTCUSDT: vizColor("blue"), ETHUSDT: vizColor("purple") }), []);

  const chart = useMemo(() => {
    const [, , days] = RANGES.find((r) => r[0] === range) || RANGES[2];
    const out = [];
    for (const u of HEADLINE) {
      const s = series[u];
      if (!s) continue;
      const cutoff = Number.isFinite(days) ? Date.now() / 1000 - days * 86400 : 0;
      // 1M is the hourly tail; anything longer reads from the daily closes.
      const pts = range === "1mo"
        ? s.hourly.filter((h) => h.time >= cutoff).map((h) => ({ x: h.time, y: h.value }))
        : s.daily.filter((d) => d.time >= cutoff).map((d) => ({ x: d.time, y: d.close }));
      if (pts.length >= 2) out.push({ label: `${LABEL[u]} BVOL`, color: colors[u], points: pts });
    }
    return out;
  }, [series, range, colors]);

  const ranks = useMemo(() => Object.fromEntries(HEADLINE.map((u) => [u, bvolRank(series[u]?.daily)])), [series]);
  const latest = HEADLINE.map((u) => series[u]).filter(Boolean);
  const stale = latest.some((s) => s.stale);
  const to = latest[0]?.to;

  return (
    <div className="rounded-xl border border-line lg-glass p-4 mb-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <div>
          <p className="text-xs text-dim font-medium">BVOL — Binance's 30-day implied-volatility index</p>
          <p className="text-[11px] text-dim">
            {to ? `Daily closes to ${to}` : "Daily history since June 2023"}
            {range === "1mo" ? ", hourly for the last month" : ""}
            {stale && <span className="text-warn"> · the nightly sync hasn't run for a few days</span>}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {RANGES.map(([id, label]) => (
            <button key={id} onClick={() => setRange(id)} className={cn("chip !text-[11px]", range === id ? "chip-active" : "chip-idle")}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-dim py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading BVOL history…
        </div>
      )}
      {error && !loading && <p className="text-sm text-down py-4">{error}</p>}

      {!loading && chart.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 mb-3">
            {HEADLINE.map((u) => {
              const r = ranks[u];
              return (
                <Stat
                  key={u}
                  label={`${LABEL[u]} BVOL`}
                  value={r ? fmtNum(r.value, 1) : series[u] ? fmtNum(series[u].daily[series[u].daily.length - 1]?.close, 1) : "–"}
                  sub={r?.rank != null ? `rank ${fmtNum(r.rank, 0)} in its 12-month range (${fmtNum(r.lo, 1)}–${fmtNum(r.hi, 1)})` : "12-month range needs more history"}
                  tone={r?.rank == null ? undefined : r.rank >= 70 ? "text-down" : r.rank <= 30 ? "text-up" : "text-text"}
                />
              );
            })}
          </div>
          <XYLineChart
            series={chart}
            height={220}
            zeroLine={false}
            fmtX={(v) => fmtDay(v, range === "max" || range === "1y")}
            fmtY={(v) => fmtNum(v, 0)}
          />
          <p className="text-[11px] text-dim mt-2 leading-relaxed">
            BVOL is to crypto what VIX is to the S&amp;P: the 30-day implied vol the options market is pricing,
            in annualised percent. It is a variance-style index, so it runs a little above the ATM IV in the
            table below — the difference is the skew premium. Rank ≥ 70 means vol is near its yearly high (premium sellers get paid most);
            ≤ 30 means it is near the low.
          </p>
        </>
      )}
    </div>
  );
}

function TermCharts({ rows }) {
  const colors = useMemo(() => ({ BTCUSDT: vizColor("blue"), ETHUSDT: vizColor("purple") }), []);
  const byU = Object.fromEntries((rows || []).map((r) => [r.underlying, r]));
  const term = HEADLINE.map((u) => byU[u]).filter((r) => r?.term?.length >= 2)
    .map((r) => ({ label: `${LABEL[r.underlying]} ATM IV`, color: colors[r.underlying], points: r.term.map((t) => ({ x: t.dte, y: t.atmIv * 100 })) }));
  const skew = HEADLINE.map((u) => byU[u]).filter((r) => r?.term?.some((t) => t.skew25 != null))
    .map((r) => ({ label: `${LABEL[r.underlying]} 25Δ skew`, color: colors[r.underlying], points: r.term.filter((t) => t.skew25 != null).map((t) => ({ x: t.dte, y: t.skew25 * 100 })) }))
    .filter((s) => s.points.length >= 2);
  if (!term.length) return null;
  return (
    <div className="grid lg:grid-cols-2 gap-3 mb-5">
      <div className="rounded-xl border border-line lg-glass p-4">
        <p className="text-xs text-dim font-medium mb-1">Term structure — ATM implied vol by days to expiry</p>
        <XYLineChart series={term} height={200} zeroLine={false} fmtX={(v) => `${fmtNum(v, 0)}d`} fmtY={(v) => `${fmtNum(v, 0)}%`} />
        <p className="text-[11px] text-dim mt-2 leading-relaxed">
          ATM IV is interpolated on the mark-IV surface at the index price for each expiry. Upward-sloping (contango)
          is the resting state; near-dated vol above far-dated (backwardation) means the market is paying up for
          the next few days — an event, or a move already under way.
        </p>
      </div>
      <div className="rounded-xl border border-line lg-glass p-4">
        <p className="text-xs text-dim font-medium mb-1">25-delta skew — put IV minus call IV, vol points</p>
        {skew.length ? (
          <XYLineChart series={skew} height={200} fmtX={(v) => `${fmtNum(v, 0)}d`} fmtY={(v) => `${v > 0 ? "+" : ""}${fmtNum(v, 1)}`} />
        ) : (
          <p className="text-sm text-dim py-6">Not enough contracts around 25 delta to read a skew.</p>
        )}
        <p className="text-[11px] text-dim mt-2 leading-relaxed">
          Positive = downside protection costs more than upside (the equity norm). Crypto often runs flat or
          negative — calls bid up in a rally — so a swing to positive is worth noticing. Only expiries where
          both a 25Δ put and a 25Δ call are bracketed by listed strikes are plotted.
        </p>
      </div>
    </div>
  );
}

function OverviewTable({ data }) {
  const rows = data?.rows || [];
  return (
    <div className="rounded-xl border border-line lg-glass overflow-hidden mb-5">
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono whitespace-nowrap">
          <thead>
            <tr className="text-left text-dim border-b border-line">
              <th className="px-3 py-2 font-sans font-medium">Underlying</th>
              <th className="px-3 py-2 font-sans font-medium text-right">Index</th>
              <th className="px-3 py-2 font-sans font-medium text-right" title="ATM implied vol interpolated to 30 days">ATM IV 30d</th>
              <th className="px-3 py-2 font-sans font-medium text-right" title="Put IV minus call IV at 25 delta, 30 days, vol points">25Δ skew</th>
              <th className="px-3 py-2 font-sans font-medium text-right" title="Put/call ratio by 24h volume (contracts)">P/C vol</th>
              <th className="px-3 py-2 font-sans font-medium text-right" title="Put/call ratio by open interest">P/C OI</th>
              <th className="px-3 py-2 font-sans font-medium text-right" title={`Open interest, expiries within ${OI_MAX_DAYS} days`}>OI ≤{OI_MAX_DAYS}d</th>
              <th className="px-3 py-2 font-sans font-medium text-right">24h turnover</th>
              <th className="px-3 py-2 font-sans font-medium text-right">Expiries</th>
              <th className="px-3 py-2 font-sans font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.underlying} className={cn("border-b border-line/40 last:border-0", r.illiquid && "text-dim")}>
                <td className="px-3 py-1.5 text-text font-semibold">{r.base}<span className="text-dim font-normal">/USDT</span></td>
                <td className="px-3 py-1.5 text-right">{r.indexPrice != null ? fmtPrice(r.indexPrice) : "–"}</td>
                <td className={cn("px-3 py-1.5 text-right", !r.illiquid && "text-text font-semibold")}>{fmtIv(r.atmIv30)}</td>
                <td className="px-3 py-1.5 text-right">{fmtSkew(r.skew30)}</td>
                <td className="px-3 py-1.5 text-right">{fmtRatio(r.pcrVolume)}</td>
                <td className="px-3 py-1.5 text-right">{fmtRatio(r.pcrOi)}</td>
                <td className="px-3 py-1.5 text-right">{fmtUsd(r.oiUsd)}</td>
                <td className="px-3 py-1.5 text-right">{fmtUsd(r.turnover24h)}</td>
                <td className="px-3 py-1.5 text-right">{r.expiries.length}</td>
                <td className="px-3 py-1.5">
                  {r.illiquid && (
                    <span className="chip chip-idle !text-[10px] !py-0 text-warn" title={`Under ${fmtUsd(ILLIQUID_TURNOVER_USDT)} traded in 24h — ratios and skew here are noise`}>
                      illiquid
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function CryptoOptionsPanel() {
  const [overview, setOverview] = useState(null);
  const [ovLoading, setOvLoading] = useState(true);
  const [ovError, setOvError] = useState(null);
  const [bvol, setBvol] = useState({});
  const [bvolLoading, setBvolLoading] = useState(true);
  const [bvolError, setBvolError] = useState(null);

  useEffect(() => {
    let alive = true;
    setOvLoading(true); setOvError(null);
    fetchOptionsOverview()
      .then((d) => { if (alive) setOverview(d); })
      .catch((e) => { if (alive) setOvError(e.message); })
      .finally(() => { if (alive) setOvLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    setBvolLoading(true); setBvolError(null);
    // One symbol failing must not hide the other; only a total miss is an error.
    Promise.allSettled(HEADLINE.map((u) => fetchBvolHistory(BVOL[u]).then((s) => [u, s])))
      .then((results) => {
        if (!alive) return;
        const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
        setBvol(Object.fromEntries(ok));
        if (!ok.length) setBvolError(results[0]?.reason?.message || "BVOL history unavailable.");
      })
      .finally(() => { if (alive) setBvolLoading(false); });
    return () => { alive = false; };
  }, []);

  return (
    <div>
      <p className="text-[11px] text-dim mb-4 max-w-2xl leading-relaxed">
        Binance lists European options on BTC and ETH with real depth, thin markets on BNB, SOL, XRP and DOGE,
        and brand-new gold and silver contracts that barely trade yet. BVOL is its 30-day implied-vol index —
        the crypto VIX. Everything below is live from Binance except the BVOL history, which is synced nightly.
      </p>

      <BvolCard series={bvol} loading={bvolLoading} error={bvolError} />

      {ovLoading && (
        <div className="flex items-center gap-2 text-sm text-dim py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading the Binance option chain…
        </div>
      )}
      {ovError && !ovLoading && <p className="text-sm text-down py-4">{ovError}</p>}
      {overview && !ovLoading && (
        <>
          <TermCharts rows={overview.rows} />
          <OverviewTable data={overview} />
          {overview.oiCoverage.failed > 0 && (
            <p className="text-[11px] text-warn mb-3">
              {overview.oiCoverage.failed} of {overview.oiCoverage.requested} open-interest lookups failed — OI columns are partial.
            </p>
          )}
        </>
      )}

      <p className="flex items-start gap-1.5 text-[10px] text-dim/80 mt-2 leading-relaxed">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Source: the Binance Options public API (live, via the site's proxy with a 30-second cache), and the BVOL
        daily archive on data.binance.vision (one row per second, sampled hourly, appended each night — the last
        point is yesterday's close). Open interest is a per-expiry call, so it covers expiries within {OI_MAX_DAYS} days
        only. "Illiquid" = under {fmtUsd(ILLIQUID_TURNOVER_USDT)} traded in 24h. Educational, not investment advice.
      </p>
    </div>
  );
}
