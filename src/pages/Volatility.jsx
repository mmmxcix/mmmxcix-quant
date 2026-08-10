import { useEffect, useMemo, useState } from "react";
import { Activity, Loader2, TrendingUp, TrendingDown, Info } from "lucide-react";
import SymbolSearch from "@/components/SymbolSearch";
import XYLineChart from "@/components/XYLineChart";
import { fetchIv, fetchIvLeaders, ivRankVerdict, premiumVerdict } from "@/lib/volData";
import { cn, fmtNum } from "@/lib/utils";

// Volatility — the RELATIVE view of options pricing that a live chain can't
// give you. Yahoo tells you today's implied vol; this tells you whether that
// number is high or low FOR THIS NAME, which is the question that actually
// decides whether you buy or sell premium.
//
// Data: the free public DoltHub `post-no-preference/options` database via
// /api/vol (2,300+ US optionable symbols, daily, back to 2019).

const toneClass = (tone) =>
  tone === "high" ? "text-down" : tone === "low" ? "text-up" : "text-text";

function Stat({ label, value, sub, tone }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3">
      <p className="text-[11px] text-dim mb-1">{label}</p>
      <p className={cn("font-mono font-semibold text-lg", tone ? toneClass(tone) : "text-text")}>{value}</p>
      {sub && <p className="text-[11px] text-dim mt-0.5">{sub}</p>}
    </div>
  );
}

// IV rank as a band: where today's vol sits between its 12-month low and high.
function RankBar({ rank }) {
  if (rank == null) return null;
  const pos = Math.max(0, Math.min(100, rank));
  return (
    <div className="mt-2">
      <div className="relative h-2 rounded-full bg-gradient-to-r from-up/40 via-line to-down/40">
        <div className="absolute -top-1 w-1 h-4 rounded-full bg-text" style={{ left: `calc(${pos}% - 2px)` }} />
      </div>
      <div className="flex justify-between text-[10px] text-dim mt-1">
        <span>52w low</span><span>52w high</span>
      </div>
    </div>
  );
}

function SymbolView() {
  const [symbol, setSymbol] = useState("SPY");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setData(null);
    fetchIv(symbol)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [symbol]);

  // A month-ago → week-ago → today read of implied vol. The upstream can't
  // serve a full daily history fast enough for an interactive page (a
  // per-symbol query there is a full table scan), so the snapshot carries
  // these three checkpoints instead — enough to see the direction.
  const series = useMemo(() => {
    if (!data) return [];
    const pts = [
      { x: 0, y: data.ivMonthAgo },
      { x: 1, y: data.ivWeekAgo },
      { x: 2, y: data.iv },
    ].filter((p) => p.y != null).map((p) => ({ x: p.x, y: p.y * 100 }));
    if (pts.length < 2) return [];
    return [{ label: "Implied vol", color: "var(--c-accent)", points: pts }];
  }, [data]);
  const TREND_LABELS = ["1 month ago", "1 week ago", "today"];

  const rankV = ivRankVerdict(data?.ivRank);
  const premV = premiumVerdict(data?.ivPremium);
  const pct = (v) => (v == null ? "–" : `${fmtNum(v * 100, 1)}%`);

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <label className="text-xs text-dim">
          Symbol
          <SymbolSearch
            market="stock"
            value={symbol}
            onSelect={(s) => setSymbol(s.toUpperCase())}
            placeholder="e.g. SPY"
            className="w-48 mt-1"
          />
        </label>
        <p className="text-[11px] text-dim pb-2">
          {data?.date ? `End-of-day ${data.date}` : "US optionable names"}
        </p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-dim py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading volatility history…
        </div>
      )}
      {error && !loading && <p className="text-sm text-down py-6">{error}</p>}

      {data?.stale && !loading && (
        <p className="text-[11px] text-warn mb-3">
          The volatility snapshot is a few days old ({data.date}) — the daily sync hasn't run recently.
        </p>
      )}
      {data && !loading && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <Stat
              label="IV rank"
              value={data.ivRank == null ? "–" : fmtNum(data.ivRank, 0)}
              sub={rankV?.label}
              tone={rankV?.tone}
            />
            <Stat
              label="Vs. other names"
              value={data.crossPercentile == null ? "–" : `${fmtNum(data.crossPercentile, 0)}%`}
              sub="of the universe ranks lower"
            />
            <Stat label="Implied vol" value={pct(data.iv)} sub={`realised ${pct(data.hv)}`} />
            <Stat
              label="IV / realised"
              value={data.ivPremium == null ? "–" : `${fmtNum(data.ivPremium, 2)}×`}
              sub={premV?.label}
              tone={premV?.tone}
            />
          </div>

          <div className="rounded-xl border border-line lg-glass p-4 mb-5">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-1">
              <p className="text-xs text-dim font-medium">Where today's vol sits in its own 12-month range</p>
              <p className="text-[11px] font-mono text-dim">
                low {pct(data.yearLow)} <span className="text-dim/60">({data.yearLowDate})</span>
                {"  ·  "}
                high {pct(data.yearHigh)} <span className="text-dim/60">({data.yearHighDate})</span>
              </p>
            </div>
            <RankBar rank={data.ivRank} />
            {rankV && <p className="text-[11px] text-dim mt-3 leading-relaxed">{rankV.note}</p>}
            {premV && <p className="text-[11px] text-dim mt-1 leading-relaxed">{premV.note}</p>}
          </div>

          {series.length > 0 && (
            <div className="rounded-xl border border-line lg-glass p-4">
              <p className="text-xs text-dim font-medium mb-2">Where implied vol has come from</p>
              <XYLineChart
                series={series}
                height={180}
                zeroLine={false}
                fmtY={(v) => `${v.toFixed(0)}%`}
                fmtX={(v) => TREND_LABELS[Math.round(v)] ?? ""}
              />
              <p className="text-[11px] text-dim mt-2 leading-relaxed">
                Implied is what options cost; realised ({pct(data.hv)}, a week ago {pct(data.hvWeekAgo)})
                is what the stock actually did. Implied above realised is the normal state — that gap is
                the premium sellers collect for carrying the risk.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LeadersView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchIvLeaders()
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const Table = ({ title, icon: Icon, rows, tone }) => (
    <div className="rounded-xl border border-line lg-glass p-4">
      <p className={cn("flex items-center gap-1.5 text-xs font-medium mb-2", tone)}>
        <Icon className="w-3.5 h-3.5" /> {title}
      </p>
      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-left text-dim border-b border-line">
            <th className="py-1 font-sans font-medium">Symbol</th>
            <th className="py-1 font-sans font-medium text-right">IV rank</th>
            <th className="py-1 font-sans font-medium text-right">IV</th>
            <th className="py-1 font-sans font-medium text-right">IV/RV</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className="border-b border-line/40 last:border-0">
              <td className="py-1 text-text">{r.symbol}</td>
              <td className={cn("py-1 text-right", tone)}>{fmtNum(r.ivRank, 0)}</td>
              <td className="py-1 text-right text-dim">{fmtNum(r.iv * 100, 1)}%</td>
              <td className="py-1 text-right text-dim">{r.ivPremium ? `${fmtNum(r.ivPremium, 2)}×` : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      {loading && (
        <div className="flex items-center gap-2 text-sm text-dim py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> Scanning the options universe…
        </div>
      )}
      {error && !loading && <p className="text-sm text-down py-6">{error}</p>}
      {data && !loading && (
        <>
          <p className="text-[11px] text-dim mb-3">
            {data.universe.toLocaleString()} optionable symbols ranked on {data.date}. IV rank is each name's
            implied vol relative to its OWN 12-month range — so a quiet utility and a biotech are comparable.
            {data.stale && <span className="text-warn"> Snapshot is a few days old.</span>}
          </p>
          <div className="grid lg:grid-cols-2 gap-3">
            <Table title="Vol most expensive (premium sellers look here)" icon={TrendingUp} rows={data.rich} tone="text-down" />
            <Table title="Vol cheapest (option buyers look here)" icon={TrendingDown} rows={data.cheap} tone="text-up" />
          </div>
        </>
      )}
    </div>
  );
}

export default function Volatility() {
  const [view, setView] = useState("symbol");
  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Options</p>
      <div className="flex items-center gap-2 mb-2">
        <Activity className="w-6 h-6 text-accent" />
        <h1 className="text-2xl font-bold">Volatility</h1>
      </div>
      <p className="text-sm text-dim mb-5 max-w-2xl">
        Is an option expensive or cheap? Not in the abstract — relative to what that same name's
        volatility has been over the last year. Free end-of-day data covering 2,300+ US optionable
        symbols. Educational, not investment advice.
      </p>

      <div className="flex items-center gap-1.5 mb-5">
        {[["symbol", "By symbol"], ["leaders", "Universe screener"]].map(([id, label]) => (
          <button key={id} onClick={() => setView(id)}
            className={cn("chip !text-[11px]", view === id ? "chip-active" : "chip-idle")}>
            {label}
          </button>
        ))}
      </div>

      {view === "symbol" ? <SymbolView /> : <LeadersView />}

      <p className="flex items-start gap-1.5 text-[10px] text-dim/80 mt-5 leading-relaxed">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Source: the public DoltHub <span className="font-mono">post-no-preference/options</span> database
        (end-of-day, updated daily, back to 2019). Free and community-maintained — it can lag or be
        briefly unavailable, in which case this page says so rather than showing stale numbers as live.
      </p>
    </div>
  );
}
