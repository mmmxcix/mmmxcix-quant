import { useEffect, useMemo, useRef, useState } from "react";
import {
  Scale, Newspaper, Layers, TrendingUp, TrendingDown, MinusCircle,
  ShieldAlert, Loader2, Sparkles, Target as TargetIcon,
} from "lucide-react";
import BiasPanel from "@/components/BiasPanel";
import { fetchStockInfo, cryptoInfoFor } from "@/lib/fundamentals";
import { fetchCandles } from "@/lib/data";
import { computeBias } from "@/lib/tradeBias";
import { computeDataBias, biasNorm, combineBias, verdictNorm, tfHorizon, HORIZON_LABEL } from "@/lib/dataBias";
import { cn, fmtPrice, fmtPct } from "@/lib/utils";

// Three ways to read the tape, chosen from one control, all on a SHARED timeframe:
//   a) rule   — the mechanical technical checklist (BiasPanel)
//   b) data   — fundamentals + a cached LLM news/macro read, WITH price targets
//   c) combined — blends a and b (more fundamental the longer the timeframe), and
//                 blends their price targets too

const TF_SECONDS = { "1s": 1, "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400, "1w": 604800, "1M": 2592000 };
const TF_RANGE = { "1s": "1h", "1m": "5d", "5m": "5d", "15m": "5d", "30m": "5d", "1h": "1mo", "2h": "1mo", "4h": "3mo", "1d": "1y", "1w": "5y", "1M": "max" };
const TF_LADDER = ["15m", "1h", "4h", "1d", "1w", "1M"];

const MODES = [
  { id: "rule", label: "Rule-based", icon: Scale, hint: "Mechanical technical checklist" },
  { id: "data", label: "News & data", icon: Newspaper, hint: "Fundamentals + current news / macro" },
  { id: "combined", label: "Combined", icon: Layers, hint: "Blends both, weighted by timeframe" },
];

// Rule-based technical bias for EVERY timeframe in the ladder — one fetch per TF,
// shared by the annotated timeframe row (all modes), the rule-based detail panel and
// the combined blend, so nothing double-fetches.
function useMultiTfBias(market, symbol) {
  const [state, setState] = useState({ results: {}, loading: true });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ results: {}, loading: true });
    Promise.allSettled(TF_LADDER.map(async (tf) => {
      const c = await fetchCandles({ market, symbol, interval: tf, range: TF_RANGE[tf] });
      return { tf, bias: computeBias(c.slice(-300)) };
    })).then((settled) => {
      if (!alive) return;
      const results = {};
      settled.forEach((r, i) => { results[TF_LADDER[i]] = r.status === "fulfilled" && r.value.bias ? { bias: r.value.bias } : { error: true }; });
      setState({ results, loading: false });
    });
    return () => { alive = false; };
  }, [market, symbol, reloadKey]);
  return { ...state, reload: () => setReloadKey((k) => k + 1) };
}

async function fetchBiasNote(market, symbol, price) {
  try {
    const q = `market=${market}&symbol=${encodeURIComponent(symbol)}${price ? `&price=${price}` : ""}`;
    const r = await fetch(`/api/bias?${q}`);
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
// A price target row with its implied move vs the live price.
// `maxMove` (optional) hides a target whose implied move vs the LIVE price is
// unrealistic for its horizon — a last-line guard so a stale/mis-anchored AI target
// (e.g. +900% over days) never shows as a real expectation.
function TargetRow({ label, price, live, highlight, maxMove }) {
  const move = live > 0 && price > 0 ? price / live - 1 : null;
  const absurd = move != null && maxMove != null && Math.abs(move) > maxMove;
  const show = price > 0 && !absurd;
  return (
    <div className={cn("flex items-center justify-between text-xs rounded px-1.5 py-1", highlight && show && "bg-accent/10")}>
      <span className={cn("text-dim", highlight && show && "text-accent font-medium")}>{label}</span>
      <span className="font-mono">
        {show ? fmtPrice(price) : "–"}
        {show && move != null && <span className={cn("ml-2", move >= 0 ? "text-up" : "text-down")}>{fmtPct(move * 100)}</span>}
      </span>
    </div>
  );
}

// ── data fetching for the fundamental view (once per symbol) ─────────────────
function useDataBias(market, symbol, price) {
  const [state, setState] = useState({ loading: true, info: null, data: null, note: null });
  const priceRef = useRef(price);
  priceRef.current = price;
  useEffect(() => {
    let alive = true;
    setState({ loading: true, info: null, data: null, note: null });
    const infoP = market === "crypto"
      ? Promise.resolve({ summary: cryptoInfoFor(symbol).summary })
      : fetchStockInfo(symbol).catch(() => null);
    Promise.all([infoP, fetchBiasNote(market, symbol, priceRef.current)]).then(([info, note]) => {
      if (!alive) return;
      setState({ loading: false, info, data: computeDataBias(info, market), note });
    });
    return () => { alive = false; };
    // price intentionally excluded — anchored at fetch time; server caches per symbol.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, symbol]);
  return state;
}

// ── b) News & data ──────────────────────────────────────────────────────────
function DataBiasBody({ market, state, biasTF, live }) {
  const { loading, info, data, note } = state;
  if (loading) return <Loading text="Reading fundamentals and current headlines…" />;

  const horizon = tfHorizon(TF_SECONDS[biasTF] || 3600);
  const detVerdict = data?.hasData ? data.verdict : null;
  const headline = detVerdict || note?.horizon?.[horizon] || "neutral";
  const t = note?.targets || {};
  const hasTargets = t.short || t.medium || t.long || (info?.targetMean && market !== "crypto");

  return (
    <div className="grid lg:grid-cols-[210px_1fr_260px] gap-4">
      {/* verdict */}
      <div className={cn("rounded-lg border p-4 flex flex-col items-center justify-center text-center", verdictClasses(headline))}>
        <VerdictIcon v={headline} className="w-8 h-8 mb-1" />
        <p className={cn("text-lg font-bold uppercase tracking-wide", headline === "long" ? "text-up" : headline === "short" ? "text-down" : "text-dim")}>
          {headline === "long" ? "Long lean" : headline === "short" ? "Short lean" : "Neutral"}
        </p>
        {data?.hasData
          ? <p className="text-xs font-mono text-dim mt-1">score {data.score > 0 ? "+" : ""}{data.score} / ±{data.maxScore}</p>
          : <p className="text-[10px] text-dim mt-1.5 leading-relaxed">{market === "crypto" ? "News & macro led (no company fundamentals)." : "Fundamentals unavailable."}</p>}
        {note?.horizon && (
          <div className="flex flex-wrap justify-center gap-1 mt-2">
            {["short", "medium", "long"].map((h) => (
              <VerdictChip key={h} verdict={note.horizon[h]} label={HORIZON_LABEL[h]} />
            ))}
          </div>
        )}
      </div>

      {/* fundamentals + LLM note */}
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
            {note?.llmFailed
              ? "The live news read didn't come back this time — showing the fundamental score only. Reload in a moment; the read is cached once it succeeds."
              : note && note.hasLLM === false
              ? "The live news read is off (no LLM provider configured) — showing the fundamental score only."
              : "No news read available for this symbol right now — showing the fundamental score only."}
          </div>
        )}
      </div>

      {/* estimated price targets */}
      <div className="rounded-lg border border-line bg-bg/30 p-3">
        <p className="flex items-center gap-1.5 text-[10px] text-dim font-medium mb-2"><TargetIcon className="w-3 h-3" /> Estimated price</p>
        {hasTargets ? (
          <div className="space-y-0.5">
            {market !== "crypto" && info?.targetMean != null && (
              <TargetRow label="Analyst mean (~12mo)" price={info.targetMean} live={live} />
            )}
            <TargetRow label={`In ${HORIZON_LABEL.short}`} price={t.short} live={live} maxMove={0.3} highlight={horizon === "short"} />
            <TargetRow label={`In ${HORIZON_LABEL.medium}`} price={t.medium} live={live} maxMove={0.7} highlight={horizon === "medium"} />
            <TargetRow label={`In ${HORIZON_LABEL.long}`} price={t.long} live={live} maxMove={2} highlight={horizon === "long"} />
            <p className="text-[10px] text-dim/80 pt-1.5 leading-relaxed">AI point estimates from fundamentals + news, not a promise. Row for the chosen {biasTF} timeframe is highlighted.</p>
          </div>
        ) : (
          <p className="text-[11px] text-dim leading-relaxed">No price estimate available (needs the live news read).</p>
        )}
      </div>
    </div>
  );
}

// ── c) Combined ───────────────────────────────────────────────────────────────
// `tech` is the rule-based bias for biasTF from the shared multi-TF hook (no extra fetch).
function CombinedBody({ biasTF, dataState, live, tech, techLoading }) {
  const { loading, data, note } = dataState;
  const tfSec = TF_SECONDS[biasTF] || 3600;
  const horizon = tfHorizon(tfSec);

  const combined = useMemo(() => {
    if (!tech || loading) return null;
    const techNorm = biasNorm(tech);
    const dataNorm = data?.hasData ? biasNorm(data) : verdictNorm(note?.horizon?.[horizon], note?.confidence ?? 0.5);
    const b = combineBias(techNorm, dataNorm, tfSec);
    // Blended price target: technical structure (near-term) and the fundamental
    // horizon estimate, weighted the same way as the direction.
    const techTgt = tech.plan?.tp1 ?? null;
    const fundTgt = note?.targets?.[horizon] ?? null;
    let target = null;
    if (techTgt && fundTgt) target = b.wTech * techTgt + b.wData * fundTgt;
    else target = techTgt ?? fundTgt;
    return { ...b, techNorm, dataNorm, techTgt, fundTgt, target };
  }, [tech, data, note, loading, tfSec, horizon]);

  if (techLoading || loading) return <Loading text="Blending technical and fundamental views…" />;
  if (!combined) return <div className="rounded-lg border border-line bg-bg/30 p-4 text-sm text-dim">Not enough data to combine on this timeframe.</div>;

  const pct = (x) => Math.round(x * 100);
  return (
    <div className="grid lg:grid-cols-[210px_1fr_260px] gap-4">
      <div className={cn("rounded-lg border p-4 flex flex-col items-center justify-center text-center", verdictClasses(combined.verdict))}>
        <VerdictIcon v={combined.verdict} className="w-8 h-8 mb-1" />
        <p className={cn("text-lg font-bold uppercase tracking-wide", combined.verdict === "long" ? "text-up" : combined.verdict === "short" ? "text-down" : "text-dim")}>
          {combined.verdict === "long" ? "Long bias" : combined.verdict === "short" ? "Short bias" : "Neutral"}
        </p>
        <p className="text-xs font-mono text-dim mt-1">blend {combined.norm >= 0 ? "+" : ""}{combined.norm.toFixed(2)}</p>
        <p className="text-[10px] text-dim mt-1.5">{biasTF} timeframe</p>
      </div>

      <div className="space-y-3">
        <div className="rounded-lg border border-line bg-bg/30 p-3">
          <p className="text-[10px] text-dim font-medium mb-2">Weighting at {biasTF} — longer timeframe leans more on fundamentals</p>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-line">
            <div className="bg-accent/70" style={{ width: `${pct(combined.wTech)}%` }} title="Technical" />
            <div className="bg-warn/70" style={{ width: `${pct(combined.wData)}%` }} title="Fundamental" />
          </div>
          <div className="flex justify-between text-[11px] mt-1.5">
            <span className="text-accent">{pct(combined.wTech)}% technical</span>
            <span className="text-warn">{pct(combined.wData)}% fundamental / news</span>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-line/60">
            <div className="flex items-center justify-between text-xs"><span className="text-dim">Technical ({biasTF})</span><VerdictChip verdict={tech.verdict} /></div>
            <div className="flex items-center justify-between text-xs"><span className="text-dim">Fundamental</span><VerdictChip verdict={data?.hasData ? data.verdict : (note?.horizon?.[horizon] || "neutral")} /></div>
          </div>
        </div>
        {note?.note && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
            <p className="flex items-center gap-1.5 text-[10px] text-accent font-medium uppercase tracking-wide mb-1.5"><Sparkles className="w-3 h-3" /> News & macro read</p>
            <p className="text-[13px] text-text/90 leading-relaxed">{note.note}</p>
          </div>
        )}
      </div>

      {/* blended + component targets */}
      <div className="rounded-lg border border-line bg-bg/30 p-3">
        <p className="flex items-center gap-1.5 text-[10px] text-dim font-medium mb-2"><TargetIcon className="w-3 h-3" /> Estimated price</p>
        <div className="space-y-0.5">
          <TargetRow label={`Combined (${HORIZON_LABEL[horizon]})`} price={combined.target} live={live} maxMove={horizon === "short" ? 0.3 : horizon === "medium" ? 0.7 : 2} highlight />
          <TargetRow label={`Technical target (${biasTF})`} price={combined.techTgt} live={live} />
          <TargetRow label={`Fundamental (${HORIZON_LABEL[horizon]})`} price={combined.fundTgt} live={live} maxMove={horizon === "short" ? 0.3 : horizon === "medium" ? 0.7 : 2} />
          {tech.plan?.stop && <TargetRow label="Technical stop" price={tech.plan.stop} live={live} />}
        </div>
        <p className="text-[10px] text-dim/80 pt-1.5 leading-relaxed">The combined target weights the technical structure and the fundamental estimate the same way as the direction.</p>
      </div>
    </div>
  );
}

function Loading({ text }) {
  return <div className="rounded-lg border border-line bg-bg/30 p-6 text-sm text-dim flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> {text}</div>;
}

// ── shell ─────────────────────────────────────────────────────────────────────
export default function BiasSection({ market, symbol, interval, price }) {
  const [mode, setMode] = useState("rule");
  const [biasTF, setBiasTF] = useState(TF_LADDER.includes(interval) ? interval : "1d");
  useEffect(() => { if (TF_LADDER.includes(interval)) setBiasTF(interval); }, [interval]);

  const dataState = useDataBias(market, symbol, price);
  const multi = useMultiTfBias(market, symbol);

  // Each timeframe chip carries its verdict for the ACTIVE view (this is the old
  // cross-check, now integrated into the timeframe row): rule → that TF's technical
  // verdict; news&data → the AI's read for the TF's horizon; combined → the blend.
  const tfVerdict = (tf) => {
    if (mode === "data") return dataState.note?.horizon?.[tfHorizon(TF_SECONDS[tf])] || null;
    const tech = multi.results[tf]?.bias;
    if (!tech) return null;
    if (mode === "rule") return tech.verdict;
    const dN = dataState.data?.hasData
      ? biasNorm(dataState.data)
      : verdictNorm(dataState.note?.horizon?.[tfHorizon(TF_SECONDS[tf])], dataState.note?.confidence ?? 0.5);
    return combineBias(biasNorm(tech), dN, TF_SECONDS[tf]).verdict;
  };

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

      {/* Shared timeframe — applies to ALL three modes, each chip showing its verdict
          (the old cross-check, now integrated here). */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        <span className="text-[10px] text-dim font-medium mr-1">Timeframe</span>
        {TF_LADDER.map((tf) => {
          const v = tfVerdict(tf);
          return (
            <button key={tf} onClick={() => setBiasTF(tf)}
              title={v ? `${tf}: ${v}` : tf}
              className={cn("flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-mono transition-colors",
                biasTF === tf ? "bg-accent/15 text-accent" : "text-dim hover:text-text hover:bg-surface")}>
              {tf}
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0",
                v === "long" ? "bg-up" : v === "short" ? "bg-down" : v === "neutral" ? "bg-dim/50" : "bg-transparent border border-line")} />
            </button>
          );
        })}
        {multi.loading && <Loader2 className="w-3 h-3 animate-spin text-dim" />}
      </div>

      {mode === "rule" && <BiasPanel selected={biasTF} bias={multi.results[biasTF]?.bias} loading={multi.loading} reload={multi.reload} />}
      {mode === "data" && <DataBiasBody market={market} state={dataState} biasTF={biasTF} live={price} />}
      {mode === "combined" && <CombinedBody biasTF={biasTF} dataState={dataState} live={price} tech={multi.results[biasTF]?.bias || null} techLoading={multi.loading} />}

      {/* Disclaimer matches the ACTIVE view, not a generic one. */}
      <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 mt-3">
        <ShieldAlert className="w-4 h-4 text-warn shrink-0 mt-0.5" />
        <p className="text-[11px] text-text/80 leading-relaxed">
          <span className="font-semibold">Not investment advice.</span> {DISCLAIMER[mode]}
        </p>
      </div>
    </div>
  );
}

const DISCLAIMER = {
  rule: "This is a fixed, mechanical checklist applied to PAST PRICE data — it knows nothing about news, fundamentals, or your situation, and timeframes can legitimately disagree. Any trade is your own decision and risk.",
  data: "This mixes public fundamentals with an AI reading of current news & macro — it can be wrong or out of date, and the price targets are rough estimates, not promises. Any trade is your own decision and risk.",
  combined: "This blends the mechanical rule-based checklist with the AI news & data read — both can be wrong, the targets are estimates, and the two methods can disagree. Any trade is your own decision and risk.",
};
