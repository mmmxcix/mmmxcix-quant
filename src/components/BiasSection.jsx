import { useEffect, useMemo, useState } from "react";
import {
  Scale, Newspaper, Layers, TrendingUp, TrendingDown, MinusCircle,
  ShieldAlert, Loader2, Sparkles,
} from "lucide-react";
import BiasPanel from "@/components/BiasPanel";
import { fetchStockInfo, cryptoInfoFor } from "@/lib/fundamentals";
import { fetchCandles } from "@/lib/data";
import { computeBias } from "@/lib/tradeBias";
import { computeDataBias, biasNorm, combineBias, horizonWeight, verdictNorm } from "@/lib/dataBias";
import { cn } from "@/lib/utils";

// Three ways to read the tape, chosen from one control:
//   a) rule   — the mechanical technical checklist (BiasPanel), unchanged
//   b) data   — fundamentals + a cached LLM news/macro read (/api/bias)
//   c) combined — blends a and b, weighting fundamentals MORE the longer the
//                 timeframe (intraday = mostly technical; multi-week = mostly news)

const TF_SECONDS = { "1s": 1, "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800, "1M": 2592000 };
const TF_RANGE = { "1s": "1h", "1m": "5d", "5m": "5d", "15m": "5d", "30m": "5d", "1h": "1mo", "2h": "1mo", "4h": "3mo", "1d": "1y", "1w": "5y", "1M": "max" };

const MODES = [
  { id: "rule", label: "Rule-based", icon: Scale, hint: "Mechanical technical checklist" },
  { id: "data", label: "News & data", icon: Newspaper, hint: "Fundamentals + current news / macro" },
  { id: "combined", label: "Combined", icon: Layers, hint: "Blends both, weighted by timeframe" },
];

async function fetchBiasNote(market, symbol) {
  try {
    const r = await fetch(`/api/bias?market=${market}&symbol=${encodeURIComponent(symbol)}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function verdictClasses(v) {
  return v === "long" ? "text-up border-up/40 bg-up/10"
    : v === "short" ? "text-down border-down/40 bg-down/10"
    : "text-dim border-line bg-bg/40";
}
function VerdictIcon({ v, className }) {
  const I = v === "long" ? TrendingUp : v === "short" ? TrendingDown : MinusCircle;
  return <I className={className} />;
}
function VerdictChip({ verdict, label }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", verdictClasses(verdict))}>
      <VerdictIcon v={verdict} className="w-3 h-3" /> {label ? `${label}: ` : ""}{verdict}
    </span>
  );
}

// ── b) News & data ──────────────────────────────────────────────────────────
function useDataBias(market, symbol) {
  const [state, setState] = useState({ loading: true, info: null, data: null, note: null, error: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, info: null, data: null, note: null, error: null });
    const infoP = market === "crypto"
      ? Promise.resolve({ summary: cryptoInfoFor(symbol).summary })
      : fetchStockInfo(symbol).catch(() => null);
    Promise.all([infoP, fetchBiasNote(market, symbol)]).then(([info, note]) => {
      if (!alive) return;
      setState({ loading: false, info, data: computeDataBias(info, market), note, error: info || market === "crypto" ? null : "no data" });
    });
    return () => { alive = false; };
  }, [market, symbol]);
  return state;
}

function DataBiasBody({ market, symbol, state }) {
  const { loading, data, note } = state;
  if (loading) return <div className="rounded-lg border border-line bg-bg/30 p-6 text-sm text-dim flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Reading fundamentals and current headlines…</div>;

  // Headline verdict: the deterministic score when it has fundamentals; else the
  // LLM's medium-horizon read (crypto / when Yahoo has nothing).
  const detVerdict = data?.hasData ? data.verdict : null;
  const llmVerdict = note?.horizon?.medium || null;
  const headline = detVerdict || llmVerdict || "neutral";

  return (
    <div className="grid lg:grid-cols-[210px_1fr] gap-4">
      <div className={cn("rounded-lg border p-4 flex flex-col items-center justify-center text-center", verdictClasses(headline))}>
        <VerdictIcon v={headline} className="w-8 h-8 mb-1" />
        <p className={cn("text-lg font-bold uppercase tracking-wide", headline === "long" ? "text-up" : headline === "short" ? "text-down" : "text-dim")}>
          {headline === "long" ? "Long lean" : headline === "short" ? "Short lean" : "Neutral"}
        </p>
        {data?.hasData
          ? <p className="text-xs font-mono text-dim mt-1">score {data.score > 0 ? "+" : ""}{data.score} / ±{data.maxScore}</p>
          : <p className="text-[10px] text-dim mt-1.5 leading-relaxed">{market === "crypto" ? "No company fundamentals — this read is news & macro led." : "Fundamentals unavailable."}</p>}
        {note?.horizon && (
          <div className="flex flex-wrap justify-center gap-1 mt-2">
            <VerdictChip verdict={note.horizon.short} label="days" />
            <VerdictChip verdict={note.horizon.medium} label="wks" />
            <VerdictChip verdict={note.horizon.long} label="mos" />
          </div>
        )}
      </div>

      <div className="space-y-3">
        {data?.hasData && (
          <div className="rounded-lg border border-line bg-bg/30 p-3">
            <p className="text-[10px] text-dim font-medium mb-2">The fundamentals (each ±1)</p>
            <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
              {data.factors.map((r) => (
                <div key={r.id} className="flex items-start gap-2 text-xs">
                  <VerdictIcon v={r.vote > 0 ? "long" : r.vote < 0 ? "short" : "neutral"} className={cn("w-3.5 h-3.5 shrink-0 mt-0.5", r.vote > 0 ? "text-up" : r.vote < 0 ? "text-down" : "text-dim")} />
                  <div className="min-w-0"><span className="text-text">{r.label}</span><span className="block text-[11px] text-dim">{r.detail}</span></div>
                </div>
              ))}
            </div>
          </div>
        )}

        {note?.note ? (
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <p className="flex items-center gap-1.5 text-[10px] text-accent font-medium uppercase tracking-wide mb-1.5">
              <Sparkles className="w-3 h-3" /> News & macro read {note.cached ? "· cached" : ""}
            </p>
            <p className="text-[13px] text-text/90 leading-relaxed">{note.note}</p>
            {note.drivers?.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {note.drivers.map((d, i) => <li key={i} className="text-[11px] text-dim flex gap-1.5"><span className="text-accent">·</span>{d}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-line bg-bg/30 p-3 text-[12px] text-dim leading-relaxed">
            {note && note.hasLLM === false
              ? "The live news read is off (no LLM provider configured) — showing the fundamental score only."
              : "No news read available for this symbol right now — showing the fundamental score only."}
          </div>
        )}
      </div>
    </div>
  );
}

// ── c) Combined ───────────────────────────────────────────────────────────────
function CombinedBody({ market, symbol, interval, dataState }) {
  const [tech, setTech] = useState(null); // technical bias for the chart TF
  useEffect(() => {
    let alive = true; setTech(null);
    fetchCandles({ market, symbol, interval, range: TF_RANGE[interval] || "1mo" })
      .then((c) => alive && setTech(computeBias(c.slice(-300))))
      .catch(() => alive && setTech(false));
    return () => { alive = false; };
  }, [market, symbol, interval]);

  const { loading, data, note } = dataState;
  const tfSec = TF_SECONDS[interval] || 3600;

  const combined = useMemo(() => {
    if (!tech || loading) return null;
    const techNorm = biasNorm(tech);
    const dataNorm = data?.hasData ? biasNorm(data) : verdictNorm(note?.horizon?.medium, note?.confidence ?? 0.5);
    return { ...combineBias(techNorm, dataNorm, tfSec), techNorm, dataNorm };
  }, [tech, data, note, loading, tfSec]);

  if (tech === null || loading) return <div className="rounded-lg border border-line bg-bg/30 p-6 text-sm text-dim flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Blending technical and fundamental views…</div>;
  if (!combined) return <div className="rounded-lg border border-line bg-bg/30 p-4 text-sm text-dim">Not enough data to combine on this timeframe.</div>;

  const pct = (x) => Math.round(x * 100);
  return (
    <div className="grid lg:grid-cols-[210px_1fr] gap-4">
      <div className={cn("rounded-lg border p-4 flex flex-col items-center justify-center text-center", verdictClasses(combined.verdict))}>
        <VerdictIcon v={combined.verdict} className="w-8 h-8 mb-1" />
        <p className={cn("text-lg font-bold uppercase tracking-wide", combined.verdict === "long" ? "text-up" : combined.verdict === "short" ? "text-down" : "text-dim")}>
          {combined.verdict === "long" ? "Long bias" : combined.verdict === "short" ? "Short bias" : "Neutral"}
        </p>
        <p className="text-xs font-mono text-dim mt-1">blend {combined.norm >= 0 ? "+" : ""}{combined.norm.toFixed(2)}</p>
        <p className="text-[10px] text-dim mt-1.5">{interval} timeframe</p>
      </div>

      <div className="space-y-3">
        <div className="rounded-lg border border-line bg-bg/30 p-3">
          <p className="text-[10px] text-dim font-medium mb-2">Weighting at {interval} — longer timeframe leans more on fundamentals</p>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-line">
            <div className="bg-accent/70" style={{ width: `${pct(combined.wTech)}%` }} title="Technical" />
            <div className="bg-warn/70" style={{ width: `${pct(combined.wData)}%` }} title="Fundamental" />
          </div>
          <div className="flex justify-between text-[11px] mt-1.5">
            <span className="text-accent">{pct(combined.wTech)}% technical</span>
            <span className="text-warn">{pct(combined.wData)}% fundamental / news</span>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-line/60">
            <div className="flex items-center justify-between text-xs">
              <span className="text-dim">Technical ({interval})</span>
              <VerdictChip verdict={tech.verdict} />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-dim">Fundamental</span>
              <VerdictChip verdict={data?.hasData ? data.verdict : (note?.horizon?.medium || "neutral")} />
            </div>
          </div>
        </div>
        {note?.note && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <p className="flex items-center gap-1.5 text-[10px] text-accent font-medium uppercase tracking-wide mb-1.5"><Sparkles className="w-3 h-3" /> News & macro read</p>
            <p className="text-[13px] text-text/90 leading-relaxed">{note.note}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── shell ─────────────────────────────────────────────────────────────────────
export default function BiasSection({ market, symbol, interval }) {
  const [mode, setMode] = useState("rule");
  const dataState = useDataBias(market, symbol);

  return (
    <div className="rounded-xl border border-line lg-glass p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Scale className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold">Bias check</h2>
        <span className="text-[10px] text-dim uppercase tracking-wide">· {symbol} · educational, not advice</span>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-line bg-bg/40 p-0.5">
          {MODES.map((m) => (
            <button key={m.id} onClick={() => setMode(m.id)} title={m.hint}
              className={cn("flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                mode === m.id ? "bg-accent/15 text-accent" : "text-dim hover:text-text")}>
              <m.icon className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{m.label}</span>
            </button>
          ))}
        </div>
      </div>

      {mode === "rule" && <BiasPanel market={market} symbol={symbol} interval={interval} embedded />}
      {mode === "data" && <DataBiasBody market={market} symbol={symbol} state={dataState} />}
      {mode === "combined" && <CombinedBody market={market} symbol={symbol} interval={interval} dataState={dataState} />}

      <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 mt-3">
        <ShieldAlert className="w-4 h-4 text-warn shrink-0 mt-0.5" />
        <p className="text-[11px] text-text/80 leading-relaxed">
          <span className="font-semibold">Not investment advice.</span> The rule-based view is a mechanical checklist on past
          prices; the news & data view mixes public fundamentals with an AI reading of current headlines and can be wrong or
          out of date. Timeframes and methods can disagree. Any trade is your own decision and risk.
        </p>
      </div>
    </div>
  );
}
