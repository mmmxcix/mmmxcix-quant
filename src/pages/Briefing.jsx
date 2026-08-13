import { useEffect, useState } from "react";
import {
  Sparkles, RefreshCw, ExternalLink, Briefcase, Newspaper,
  TrendingUp, TrendingDown, MinusCircle, Target, ShieldAlert,
} from "lucide-react";
import { distinctSymbols } from "@/lib/portfolio";
import { cn } from "@/lib/utils";

// Briefing — the AI-synthesized counterpart to Headlines: a market pulse, a
// per-holding "is this actually relevant" read, and curated top stories with
// a real synthesis instead of a raw RSS teaser. One endpoint (/api/briefing)
// powers this AND the email digest, so relevance/synthesis is computed once.
// Visual language mirrors src/components/BiasSection.jsx's "News & data" card
// (the app's existing precedent for AI-read content) rather than inventing a
// new one — same accent-tinted callout, same verdict-chip vocabulary.

function relTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function stanceClasses(v) {
  return v === "long" ? "text-up border-up/40 bg-up/10"
    : v === "short" ? "text-down border-down/40 bg-down/10"
    : "text-dim border-line bg-bg/40";
}
function StanceChip({ stance }) {
  const Icon = stance === "long" ? TrendingUp : stance === "short" ? TrendingDown : MinusCircle;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", stanceClasses(stance))}>
      <Icon className="w-3 h-3" /> {stance}
    </span>
  );
}

function HeadlineLink({ it }) {
  return (
    <a href={it.link} target="_blank" rel="noopener noreferrer"
      className="group flex items-start justify-between gap-2 py-1 text-xs">
      <span className="text-text/80 group-hover:text-accent transition-colors leading-snug">{it.title}</span>
      <span className="shrink-0 text-dim whitespace-nowrap">{it.source}{it.pubDate ? ` · ${relTime(it.pubDate)}` : ""}</span>
    </a>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-line lg-glass p-4 space-y-2">
      <div className="h-4 w-1/3 rounded skeleton" />
      <div className="h-3 w-full rounded skeleton" />
      <div className="h-3 w-2/3 rounded skeleton" />
    </div>
  );
}

function HoldingCard({ symbol, data }) {
  const hasStory = data.enriched && (data.why || data.expectation);
  return (
    <div className="rounded-xl border border-line lg-glass p-4">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="font-mono text-sm font-semibold text-text">{symbol}</span>
        <span className="text-xs text-dim truncate">{data.name}</span>
        {data.enriched && <StanceChip stance={data.stance} />}
        {!data.enriched && (
          <span className="text-[10px] text-dim uppercase tracking-wide ml-auto">Not yet analyzed</span>
        )}
      </div>

      {hasStory && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 mb-2 space-y-2">
          {data.why && !data.newsBased && (
            <p className="text-[9px] uppercase tracking-wide text-dim">No fresh headlines · fundamentals view</p>
          )}
          {data.why && <p className="text-[13px] font-medium text-text leading-relaxed">{data.why}</p>}
          {data.keyFacts?.length > 0 && (
            <ul className="list-disc pl-4 space-y-1">
              {data.keyFacts.map((f, i) => <li key={i} className="text-[12px] text-text/80 leading-relaxed">{f}</li>)}
            </ul>
          )}
          {data.expectation && (
            <p className="flex items-start gap-1.5 text-[12px] text-accent">
              <Target className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{data.expectation}</span>
            </p>
          )}
        </div>
      )}

      {data.relevantHeadlines?.length > 0 ? (
        <div className="divide-y divide-line/60">
          {data.relevantHeadlines.map((it, i) => <HeadlineLink key={i} it={it} />)}
        </div>
      ) : !data.why ? (
        <p className="text-xs text-dim">No headlines specifically about {data.name} today.</p>
      ) : null}
    </div>
  );
}

export default function Briefing() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      const symbols = distinctSymbols();
      const res = await fetch("/api/briefing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbols }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const symbolEntries = data ? Object.entries(data.symbols || {}) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-medium text-dim">Markets</div>
          <h1 className="text-2xl font-semibold text-text mt-1">Briefing</h1>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl border border-line lg-glass px-3 py-2 text-sm text-dim hover:border-accent/40 hover:text-text transition-colors disabled:opacity-60"
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {loading && !data && (
        <div className="space-y-3">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {!loading && error && !data && (
        <div className="rounded-xl border border-line lg-glass p-6 text-center">
          <p className="text-text font-medium">Briefing could not be loaded.</p>
          <button onClick={load} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm text-dim hover:border-accent/40 hover:text-text transition-colors">
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      )}

      {data && (
        <>
          {data.pulse ? (
            <div className="rounded-xl border border-accent/30 bg-accent/5 p-4">
              <p className="flex items-center gap-1.5 text-[10px] text-accent font-medium uppercase tracking-wide mb-1.5">
                <Sparkles className="w-3.5 h-3.5" /> Market pulse
              </p>
              <p className="text-sm text-text/90 leading-relaxed">{data.pulse.summary}</p>
            </div>
          ) : !data.hasLLM && (
            <div className="rounded-xl border border-line lg-glass p-4 text-sm text-dim">
              AI synthesis isn't configured on this deployment yet — showing headline matches only.
            </div>
          )}

          {symbolEntries.length > 0 && (
            <div>
              <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-dim mb-2">
                <Briefcase className="w-3.5 h-3.5" /> Your holdings
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {symbolEntries.map(([symbol, d]) => <HoldingCard key={symbol} symbol={symbol} data={d} />)}
              </div>
            </div>
          )}

          {data.stories?.length > 0 && (
            <div>
              <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-dim mb-2">
                <Newspaper className="w-3.5 h-3.5" /> Top stories
              </p>
              <div className="space-y-3">
                {data.stories.map((s, i) => (
                  <article key={i} className="rounded-xl border border-line lg-glass p-4 hover:border-accent/40 transition-colors">
                    <div className="flex flex-wrap items-center gap-3 mb-2">
                      <span className="rounded-full border border-accent/40 px-2 py-0.5 text-[11px] text-accent">{s.source}</span>
                      <span className="text-xs text-dim">{relTime(s.pubDate)}</span>
                    </div>
                    <a href={s.link} target="_blank" rel="noopener noreferrer"
                      className="group inline-flex items-start gap-1.5 text-text font-medium leading-snug hover:text-accent transition-colors">
                      <span>{s.title}</span>
                      <ExternalLink size={13} className="mt-1 shrink-0 text-dim group-hover:text-accent transition-colors" />
                    </a>
                    <p className="mt-2 text-sm text-dim leading-relaxed">{s.synthesis}</p>
                  </article>
                ))}
              </div>
            </div>
          )}

          {symbolEntries.length === 0 && !data.stories?.length && !data.pulse && (
            <div className="rounded-xl border border-line lg-glass p-6 text-center">
              <p className="text-text font-medium">Nothing to show yet.</p>
              <p className="text-dim text-sm mt-2">
                Add symbols to your <a href="/portfolio" className="text-accent hover:underline">portfolio</a> or{" "}
                <a href="/?view=watchlist" className="text-accent hover:underline">watchlist</a> for a personalized read.
              </p>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3">
            <ShieldAlert className="w-4 h-4 text-warn shrink-0 mt-0.5" />
            <p className="text-[11px] text-text/80 leading-relaxed">
              <span className="font-semibold">Not investment advice.</span> AI-generated synthesis of public headlines and fundamentals — it can be wrong or out of date. Any trade is your own decision and risk.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
