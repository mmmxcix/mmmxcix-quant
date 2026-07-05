import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw, Search } from 'lucide-react';

const SOURCES = ['Alle', 'CNBC', 'Yahoo Finance', 'CoinDesk', 'MarketWatch'];

function relativeTimeDe(iso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (isNaN(then)) return '';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'gerade eben';
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'vor 1 Tag';
  return `vor ${d} Tagen`;
}

function SkeletonRow() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 animate-pulse">
      <div className="flex items-center gap-3 mb-3">
        <div className="h-5 w-20 rounded-full bg-line" />
        <div className="h-3 w-16 rounded bg-line" />
      </div>
      <div className="h-4 w-3/4 rounded bg-line mb-2" />
      <div className="h-3 w-full rounded bg-line mb-1" />
      <div className="h-3 w-2/3 rounded bg-line" />
    </div>
  );
}

export default function News() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('Alle');
  const [query, setQuery] = useState('');

  async function load() {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/news');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error || !Array.isArray(data.items)) throw new Error('feeds_unavailable');
      setItems(data.items);
    } catch {
      setError(true);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (sourceFilter !== 'Alle' && it.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        (it.title || '').toLowerCase().includes(q) ||
        (it.description || '').toLowerCase().includes(q)
      );
    });
  }, [items, sourceFilter, query]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-dim">Märkte</div>
          <h1 className="text-2xl font-semibold text-text mt-1">News</h1>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-dim hover:border-accent/40 hover:text-text transition-colors disabled:opacity-60"
          title="Aktualisieren"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Aktualisieren
        </button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex flex-wrap gap-2">
          {SOURCES.map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(s)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                sourceFilter === s
                  ? 'border-accent text-accent'
                  : 'border-line text-dim hover:border-accent/40 hover:text-text'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="relative sm:ml-auto">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Suchen…"
            className="w-full sm:w-64 rounded-xl border border-line bg-surface pl-9 pr-3 py-2 text-sm text-text placeholder:text-dim focus:outline-none focus:border-accent/40"
          />
        </div>
      </div>

      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-line bg-surface p-6 text-center">
          <p className="text-text font-medium">News konnten nicht geladen werden.</p>
          <p className="text-dim text-sm mt-2">
            Hinweis: Der News-Feed läuft über eine Cloudflare Pages Function
            (<code className="text-accent">/api/news</code>) und funktioniert nur auf der
            deployten Seite — nicht im lokalen <code className="text-accent">vite dev</code>-Server.
          </p>
          <button
            onClick={load}
            className="mt-4 inline-flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm text-dim hover:border-accent/40 hover:text-text transition-colors"
          >
            <RefreshCw size={14} />
            Erneut versuchen
          </button>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-xl border border-line bg-surface p-6 text-center text-dim text-sm">
          Keine Meldungen gefunden.
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map((it, i) => (
            <article
              key={`${it.link}-${i}`}
              className="rounded-xl border border-line bg-surface p-4 hover:border-accent/40 transition-colors"
            >
              <div className="flex items-center gap-3 mb-2">
                <span className="rounded-full border border-accent/40 px-2 py-0.5 text-[11px] text-accent">
                  {it.source}
                </span>
                <span className="text-xs text-dim">{relativeTimeDe(it.pubDate)}</span>
              </div>
              <a
                href={it.link}
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-start gap-1.5 text-text font-medium leading-snug hover:text-accent transition-colors"
              >
                <span>{it.title}</span>
                <ExternalLink
                  size={13}
                  className="mt-1 shrink-0 text-dim group-hover:text-accent transition-colors"
                />
              </a>
              {it.description && (
                <p className="mt-2 text-sm text-dim leading-relaxed">{it.description}</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
