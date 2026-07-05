import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw, Search } from 'lucide-react';

const CATEGORIES = [
  { value: 'Alle', label: 'Alle' },
  { value: 'markets', label: 'Märkte' },
  { value: 'crypto', label: 'Krypto' },
  { value: 'business', label: 'Business' },
];

const ACCESS_OPTIONS = [
  { value: 'Alle', label: 'Alle' },
  { value: 'free', label: 'Nur gratis' },
];

const SORT_OPTIONS = [
  { value: 'newest', label: 'Neueste zuerst' },
  { value: 'oldest', label: 'Älteste zuerst' },
  { value: 'source', label: 'Nach Quelle A–Z' },
];

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

function FilterChip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? 'border-accent text-accent'
          : 'border-line text-dim hover:border-accent/40 hover:text-text'
      }`}
    >
      {children}
    </button>
  );
}

function SkeletonRow() {
  return (
    <div className="rounded-xl border border-line lg-glass p-4 animate-pulse">
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
  const [categoryFilter, setCategoryFilter] = useState('Alle');
  const [accessFilter, setAccessFilter] = useState('Alle');
  const [sortBy, setSortBy] = useState('newest');
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

  const sources = useMemo(() => {
    const set = new Set(items.map((it) => it.source).filter(Boolean));
    return ['Alle', ...[...set].sort((a, b) => a.localeCompare(b, 'de'))];
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const result = items.filter((it) => {
      if (sourceFilter !== 'Alle' && it.source !== sourceFilter) return false;
      if (categoryFilter !== 'Alle' && it.category !== categoryFilter) return false;
      if (accessFilter === 'free' && it.access !== 'free') return false;
      if (!q) return true;
      return (
        (it.title || '').toLowerCase().includes(q) ||
        (it.description || '').toLowerCase().includes(q)
      );
    });

    result.sort((a, b) => {
      if (sortBy === 'source') {
        const bySource = (a.source || '').localeCompare(b.source || '', 'de');
        if (bySource !== 0) return bySource;
      }
      const ta = a.pubDate ? Date.parse(a.pubDate) : 0;
      const tb = b.pubDate ? Date.parse(b.pubDate) : 0;
      return sortBy === 'oldest' ? ta - tb : tb - ta;
    });

    return result;
  }, [items, sourceFilter, categoryFilter, accessFilter, sortBy, query]);

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
          className="inline-flex items-center gap-2 rounded-xl border border-line lg-glass px-3 py-2 text-sm text-dim hover:border-accent/40 hover:text-text transition-colors disabled:opacity-60"
          title="Aktualisieren"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Aktualisieren
        </button>
      </div>

      <div className="rounded-xl border border-line lg-glass p-3 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-dim w-16 shrink-0">
              Quelle
            </span>
            {sources.map((s) => (
              <FilterChip key={s} active={sourceFilter === s} onClick={() => setSourceFilter(s)}>
                {s}
              </FilterChip>
            ))}
          </div>
          <div className="relative sm:ml-auto">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Suchen…"
              className="w-full sm:w-64 rounded-xl border border-line lg-glass pl-9 pr-3 py-2 text-sm text-text placeholder:text-dim focus:outline-none focus:border-accent/40"
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-dim w-16 shrink-0">
              Thema
            </span>
            {CATEGORIES.map((c) => (
              <FilterChip
                key={c.value}
                active={categoryFilter === c.value}
                onClick={() => setCategoryFilter(c.value)}
              >
                {c.label}
              </FilterChip>
            ))}
            <span className="mx-1 h-4 w-px bg-line hidden sm:block" />
            {ACCESS_OPTIONS.map((a) => (
              <FilterChip
                key={a.value}
                active={accessFilter === a.value}
                onClick={() => setAccessFilter(a.value)}
              >
                {a.label}
              </FilterChip>
            ))}
          </div>
          <div className="flex items-center gap-3 sm:ml-auto">
            {!loading && !error && (
              <span className="text-xs text-dim whitespace-nowrap">
                {filtered.length} Artikel
              </span>
            )}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="rounded-xl border border-line lg-glass px-3 py-2 text-sm text-text focus:outline-none focus:border-accent/40"
              title="Sortierung"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
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
        <div className="rounded-xl border border-line lg-glass p-6 text-center">
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
        <div className="rounded-xl border border-line lg-glass p-6 text-center">
          <p className="text-text font-medium">Keine Meldungen gefunden.</p>
          <p className="text-dim text-sm mt-2">
            Keine Artikel entsprechen den aktuellen Filtern. Filter zurücksetzen oder Suche anpassen.
          </p>
          <button
            onClick={() => {
              setSourceFilter('Alle');
              setCategoryFilter('Alle');
              setAccessFilter('Alle');
              setQuery('');
            }}
            className="mt-4 inline-flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm text-dim hover:border-accent/40 hover:text-text transition-colors"
          >
            Filter zurücksetzen
          </button>
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map((it, i) => (
            <article
              key={`${it.link}-${i}`}
              className="rounded-xl border border-line lg-glass p-4 hover:border-accent/40 transition-colors"
            >
              <div className="flex flex-wrap items-center gap-3 mb-2">
                <span className="rounded-full border border-accent/40 px-2 py-0.5 text-[11px] text-accent">
                  {it.source}
                </span>
                {it.access === 'partial-paywall' && (
                  <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-dim">
                    Paywall möglich
                  </span>
                )}
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
