import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, Mail, RefreshCw, Search } from 'lucide-react';
import { distinctSymbols } from '@/lib/portfolio';

// Sources selectable for the digest, with their access tier (matches
// functions/api/news.js). "partial" sources are hidden when free-only is on.
const DIGEST_SOURCES = [
  { name: 'CNBC', access: 'free' },
  { name: 'Yahoo Finance', access: 'free' },
  { name: 'CoinDesk', access: 'free' },
  { name: 'Investing.com', access: 'free' },
  { name: 'Cointelegraph', access: 'free' },
  { name: 'MarketWatch', access: 'partial' },
];

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

const NEWSLETTER_LINKS = [
  { label: 'CNBC Newsletters', url: 'https://www.cnbc.com/newsletters/' },
  { label: 'MarketWatch Newsletters', url: 'https://www.marketwatch.com/newsletters' },
  { label: 'CoinDesk Newsletters', url: 'https://www.coindesk.com/newsletters/' },
  { label: 'Yahoo Finance Morning Brief', url: 'https://finance.yahoo.com/newsletters/' },
  { label: 'Cointelegraph', url: 'https://cointelegraph.com/newsletter' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function NewsletterCard() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | pending | updated | invalid | error | kv

  // Digest preferences
  const [categories, setCategories] = useState(['general']); // general | watchlist | portfolio
  const [freeOnly, setFreeOnly] = useState(true);
  const [sources, setSources] = useState(null); // null = all; else array of names

  const toggleCategory = (c) =>
    setCategories((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  const toggleSource = (name) =>
    setSources((cur) => {
      const base = cur || DIGEST_SOURCES.filter((s) => !freeOnly || s.access === 'free').map((s) => s.name);
      const next = base.includes(name) ? base.filter((x) => x !== name) : [...base, name];
      return next;
    });

  async function subscribe(e) {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      setStatus('invalid');
      return;
    }
    if (categories.length === 0) {
      setStatus('nocat');
      return;
    }
    setStatus('sending');
    // Portfolio/watchlist categories need the user's symbols so the digest can
    // match news to them. distinctSymbols() reads localStorage (this browser).
    const wantsSymbols = categories.includes('watchlist') || categories.includes('portfolio');
    const symbols = wantsSymbols ? distinctSymbols() : [];
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: value, prefs: { categories, freeOnly, sources, symbols } }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503 && data.error === 'kv_not_configured') setStatus('kv');
      else if (res.ok && data.status === 'updated') setStatus('updated');
      else if (res.ok && data.status === 'pending_confirm') { setStatus('pending'); }
      else setStatus('error');
    } catch {
      setStatus('error');
    }
  }

  const availableSources = DIGEST_SOURCES.filter((s) => !freeOnly || s.access === 'free');
  const selectedSources = sources || availableSources.map((s) => s.name);

  return (
    <div className="rounded-xl border border-line lg-glass">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-3 text-left"
        aria-expanded={open}
      >
        <Mail size={15} className="text-accent shrink-0" />
        <span className="text-sm font-medium text-text">Newsletter</span>
        <span className="text-xs text-dim hidden sm:inline">
          Markt-Updates direkt ins Postfach
        </span>
        <ChevronDown
          size={15}
          className={`ml-auto shrink-0 text-dim transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="border-t border-line p-4 grid gap-6 md:grid-cols-2">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-dim mb-2">
              Direkt-Abos
            </div>
            <p className="text-xs text-dim mb-3">Gratis-Newsletter der Quellen:</p>
            <ul className="space-y-1.5">
              {NEWSLETTER_LINKS.map((l) => (
                <li key={l.url}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group inline-flex items-center gap-1.5 text-sm text-text hover:text-accent transition-colors"
                  >
                    <span>{l.label}</span>
                    <ExternalLink
                      size={12}
                      className="shrink-0 text-dim group-hover:text-accent transition-colors"
                    />
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wider text-dim mb-2">
              MMMXCIX Daily Digest
            </div>
            <p className="text-xs text-dim mb-3">
              Einmal täglich die wichtigsten Schlagzeilen — du wählst, worüber und aus welchen Quellen.
            </p>

            {/* Was */}
            <p className="text-[11px] text-dim mb-1.5">Worüber?</p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {[
                { id: 'general', label: 'Allgemeine Finanznews' },
                { id: 'watchlist', label: 'Meine Watchlist' },
                { id: 'portfolio', label: 'Mein Portfolio' },
              ].map((c) => (
                <button key={c.id} type="button" onClick={() => toggleCategory(c.id)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    categories.includes(c.id) ? 'border-accent text-accent bg-accent/10' : 'border-line text-dim hover:text-text'
                  }`}>
                  {c.label}
                </button>
              ))}
            </div>

            {/* Quellen + gratis */}
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] text-dim">Aus welchen Quellen?</p>
              <label className="flex items-center gap-1.5 text-[11px] text-dim cursor-pointer select-none">
                <input type="checkbox" checked={freeOnly}
                  onChange={(e) => { setFreeOnly(e.target.checked); setSources(null); }}
                  className="accent-[#2dd4bf]" />
                Nur gratis
              </label>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {availableSources.map((s) => (
                <button key={s.name} type="button" onClick={() => toggleSource(s.name)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    selectedSources.includes(s.name) ? 'border-accent text-accent bg-accent/10' : 'border-line text-dim hover:text-text'
                  }`}>
                  {s.name}{s.access === 'partial' ? ' ·$' : ''}
                </button>
              ))}
            </div>

            <form onSubmit={subscribe} className="flex flex-col sm:flex-row gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); if (status !== 'idle') setStatus('idle'); }}
                placeholder="deine@email.com"
                className="input-base flex-1 min-w-0"
                aria-label="E-Mail-Adresse"
              />
              <button type="submit" disabled={status === 'sending'} className="btn-accent shrink-0">
                {status === 'sending' ? 'Sende…' : 'Abonnieren'}
              </button>
            </form>

            {status === 'pending' && (
              <p className="mt-2 text-xs text-accent">
                Fast geschafft! Wir haben dir eine Bestätigungsmail geschickt — bitte den Link darin anklicken.
              </p>
            )}
            {status === 'updated' && (
              <p className="mt-2 text-xs text-accent">Deine Einstellungen wurden aktualisiert.</p>
            )}
            {status === 'nocat' && (
              <p className="mt-2 text-xs text-red-400">Wähle mindestens eine Kategorie aus.</p>
            )}
            {status === 'invalid' && (
              <p className="mt-2 text-xs text-red-400">Bitte eine gültige E-Mail-Adresse eingeben.</p>
            )}
            {status === 'kv' && (
              <p className="mt-2 text-xs text-red-400">
                Anmeldung derzeit nicht möglich: KV-Binding <code className="text-accent">SUBSCRIBERS</code> fehlt.
              </p>
            )}
            {status === 'error' && (
              <p className="mt-2 text-xs text-red-400">Anmeldung fehlgeschlagen. Bitte später erneut versuchen.</p>
            )}
            <p className="mt-3 text-[11px] text-dim">
              Für Watchlist/Portfolio-News werden die Symbole aus diesem Browser übermittelt. Double-Opt-In,
              jederzeit abbestellbar, keine Weitergabe. „·$" = teils kostenpflichtige Quelle. Details:{" "}
              <a href="/datenschutz" className="text-accent hover:underline">Datenschutz</a>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
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

      <NewsletterCard />

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
