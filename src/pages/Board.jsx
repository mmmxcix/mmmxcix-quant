import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LayoutList, MessageSquare, RefreshCw, Terminal, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { cliEnabled, cliModel, cliUrl, omniComplete, omniEnabled, omniModel, omniUrl } from "@/lib/omniroute";

// The board — one screen over the three agents, the market, the charts and the
// news, all of it served by /api/board from the catalog in src/lib/board.
//
// Two halves on purpose. The TOP is the standing question ("what is going on")
// answered in one round trip, so it is worth opening every morning. The BOTTOM
// is the inspector: every resource in the catalog, its arguments, its digest and
// its raw data. That half exists because the catalog is also the tool list the
// chat will get — being able to see exactly what a resource returns, and what it
// says when it has nothing, is how you find out whether a question is answerable
// before wiring a model to it.

const OVERVIEW = [
  { resource: "argus.status" },
  { resource: "argus.positions" },
  { resource: "argus.performance", args: { by: "session", minN: 3 } },
  { resource: "kronos.state" },
  { resource: "arena.state" },
  { resource: "market.quotes", args: { panel: "crypto" } },
  { resource: "news.headlines", args: { window: "24h", limit: 10 } },
  { resource: "news.telegram", args: { window: "6h", limit: 8 } },
];

// Loaded after the first paint, in its own batch: the London archive is a slow
// upstream and the hazards source fans out to two endpoints. Neither should
// hold up the answer to "what is going on right now".
const WIDER = [
  { resource: "world.layers" },
  { resource: "world.hazards", args: { top: 5 } },
  { resource: "macro.yields", args: { country: "US", lookbackDays: 90 } },
];

// Loaded only for the admin session — these read the dev's private endpoints
// (/api/lab, /api/library, /api/prefs) and the server refuses them to anyone
// else, so a second batch keeps the public path from carrying refusals it can
// do nothing about.
const PRIVATE = [
  { resource: "cortex.state" },
  { resource: "registry.strategies", args: { limit: 12 } },
  { resource: "portfolio.holdings" },
  { resource: "portfolio.watchlist" },
  { resource: "ml.track", args: { limit: 8 } },
];

const REFRESH_MS = 60_000;

async function readBoard(reads) {
  const res = await fetch("/api/board", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reads }),
  });
  if (!res.ok) throw new Error(`board ${res.status}`);
  return res.json();
}

function ago(t) {
  if (!t) return "never";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** A digest is fixed-width text on purpose — the same bytes go to the terminal and, later, to a prompt. */
function Digest({ text }) {
  return (
    <pre className="mt-2 overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed text-fg/90">
      {text}
    </pre>
  );
}

function Panel({ read, title, className }) {
  if (!read) {
    return (
      <section className={cn("rounded-xl border border-line bg-surface/40 p-4", className)}>
        <div className="h-3 w-24 animate-pulse rounded bg-line/60" />
        <div className="mt-3 h-16 animate-pulse rounded bg-line/40" />
      </section>
    );
  }
  const failed = !read.ok;
  return (
    <section className={cn("rounded-xl border border-line bg-surface/40 p-4", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <code className="text-[10px] text-dim">{read.resource}</code>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-dim">
          {read.ok && read.asOf ? ago(read.asOf) : null}
          {read.ok && read.stale && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-2 py-0.5 text-warn">
              <TriangleAlert className="h-3 w-3" aria-hidden="true" />
              stale
            </span>
          )}
        </span>
      </div>
      {failed ? (
        <p className="mt-2 text-sm text-down" role="status">
          {read.error === "source_unavailable"
            ? "This source is not answering right now."
            : read.error}
          {read.detail ? <span className="text-dim"> — {read.detail}</span> : null}
        </p>
      ) : (
        <Digest text={read.digest} />
      )}
    </section>
  );
}

// ── ask ─────────────────────────────────────────────────────────────────────
// The chat is deliberately thin: the server plans, reads and answers. What this
// component adds is (a) the LOCAL path — when OmniRoute or the CLI shim is
// configured, the two model turns run on the user's own machine and the server
// only executes the reads — and (b) showing the evidence next to the answer,
// because an answer whose digests you cannot see is a claim, not a result.

function Ask() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const [showEvidence, setShowEvidence] = useState(false);

  const local = cliEnabled() || omniEnabled();
  const endpoint = cliEnabled() ? { url: cliUrl(), model: cliModel() } : { url: omniUrl(), model: omniModel() };

  const run = useCallback(async () => {
    const question = q.trim();
    if (!question) return;
    setBusy(true);
    setOut(null);
    try {
      let res;
      if (local) {
        // 1) the server hands back the planner prompt (no provider key spent)
        const p = await fetch("/api/ask", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ question, promptOnly: true }),
        }).then((r) => r.json());
        // 2) the local model plans
        const planText = await omniComplete({ system: p.system, user: p.user, ...endpoint });
        if (!planText) throw new Error("the local model did not answer — is OmniRoute running?");
        // 3) the server executes the reads and returns the answer prompt
        const ex = await fetch("/api/ask", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ question, plan: planText }),
        }).then((r) => r.json());
        if (!ex.ok) throw new Error(ex.error || "the plan was rejected");
        // 4) the local model answers from the digests
        const answer = await omniComplete({ system: ex.answer.system, user: ex.answer.user, ...endpoint });
        res = { ...ex, answer: answer || "The reads succeeded; the local model did not summarise them.", model: endpoint.model };
      } else {
        res = await fetch("/api/ask", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ question }),
        }).then((r) => r.json());
        if (!res.ok) throw new Error(res.hint || res.error || "no answer");
      }
      setOut(res);
    } catch (e) {
      setOut({ error: String(e.message || e) });
    } finally {
      setBusy(false);
    }
  }, [q, local, endpoint]);

  return (
    <section className="rounded-xl border border-line bg-surface/40 p-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-accent" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Ask</h2>
        <span className="text-[11px] text-dim">
          {local ? `local model · ${endpoint.model}` : "free provider chain"}
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        <label htmlFor="ask-q" className="sr-only">Question</label>
        <input
          id="ask-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) run(); }}
          placeholder="Which Argus setups actually lose money, and in which session?"
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={run}
          disabled={busy || !q.trim()}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {busy ? "Reading…" : "Ask"}
        </button>
      </div>

      {out?.error && <p className="mt-3 text-sm text-down" role="status">{out.error}</p>}

      {out && !out.error && (
        <div className="mt-3">
          <p className="whitespace-pre-wrap text-sm">{out.answer}</p>
          <p className="mt-2 text-[11px] text-dim">
            {out.model ? `${out.model} · ` : ""}
            read {out.reads?.length || 0} resource{(out.reads?.length || 0) === 1 ? "" : "s"}
            {out.reads?.length ? `: ${out.reads.map((r) => r.resource).join(", ")}` : ""}
            {out.dropped?.length ? ` · asked for ${out.dropped.join(", ")}, which does not exist` : ""}
          </p>
          {!!out.reads?.length && (
            <>
              <button
                type="button"
                onClick={() => setShowEvidence((s) => !s)}
                className="mt-1 text-[11px] text-dim underline decoration-dotted hover:text-accent"
              >
                {showEvidence ? "hide" : "show"} the evidence it read
              </button>
              {showEvidence && (
                <div className="mt-2 space-y-2">
                  {out.reads.map((r, i) => (
                    // Keyed by index: one plan often reads the same resource
                    // twice with different arguments.
                    <div key={`${r.resource}-${i}`} className="rounded-lg border border-line bg-bg p-2">
                      <p className="text-[10px] uppercase tracking-wide text-dim">
                        {r.resource}
                        {r.args && Object.keys(r.args).length
                          ? ` (${Object.entries(r.args).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${v}`).join(", ")})`
                          : ""}
                        {r.stale ? " · stale" : ""}
                      </p>
                      <Digest text={r.ok ? r.digest : `failed: ${r.error}`} />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ── the inspector ───────────────────────────────────────────────────────────

function ArgField({ spec, value, onChange }) {
  const id = `arg-${spec.name}`;
  const common = "w-full rounded-lg border border-line bg-bg px-2 py-1 text-xs";
  return (
    <label htmlFor={id} className="block">
      <span className="block text-[10px] uppercase tracking-wide text-dim">
        {spec.name}
        {spec.required ? " *" : ""}
      </span>
      {spec.type === "enum" ? (
        <select id={id} className={common} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          {!spec.required && <option value="">— any —</option>}
          {spec.values.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      ) : spec.type === "bool" ? (
        <input
          id={id}
          type="checkbox"
          className="mt-1"
          checked={value === true || value === "true"}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : (
        <input
          id={id}
          type={spec.type === "int" || spec.type === "number" ? "number" : "text"}
          className={common}
          value={value ?? ""}
          placeholder={spec.default != null ? String(spec.default) : spec.type}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

function Inspector({ catalog }) {
  const [id, setId] = useState("argus.performance");
  const [args, setArgs] = useState({});
  const [read, setRead] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const spec = useMemo(() => catalog.find((r) => r.id === id) || null, [catalog, id]);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== "" && v != null));
      const out = await readBoard([{ resource: id, args: clean }]);
      setRead(out.reads[0]);
    } catch (e) {
      setRead({ resource: id, ok: false, error: String(e.message || e) });
    } finally {
      setBusy(false);
    }
  }, [id, args]);

  useEffect(() => { setArgs({}); setRead(null); }, [id]);

  return (
    <section className="rounded-xl border border-line bg-surface/40 p-4">
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-accent" aria-hidden="true" />
        <h2 className="text-sm font-semibold">Inspector</h2>
        <span className="text-[11px] text-dim">{catalog.length} resources</span>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,20rem)_1fr]">
        <div>
          <label htmlFor="board-resource" className="block text-[10px] uppercase tracking-wide text-dim">
            resource
          </label>
          <select
            id="board-resource"
            className="w-full rounded-lg border border-line bg-bg px-2 py-1 text-xs"
            value={id}
            onChange={(e) => setId(e.target.value)}
          >
            {catalog.map((r) => (
              <option key={r.id} value={r.id}>{r.id}</option>
            ))}
          </select>
          {spec && <p className="mt-2 text-xs text-dim">{spec.summary}</p>}

          {spec && spec.args.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {spec.args.map((a) => (
                <ArgField
                  key={a.name}
                  spec={a}
                  value={args[a.name]}
                  onChange={(v) => setArgs((prev) => ({ ...prev, [a.name]: v }))}
                />
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="mt-3 rounded-lg border border-line px-3 py-1.5 text-xs font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {busy ? "Reading…" : "Read"}
          </button>
        </div>

        <div className="min-w-0">
          {!read && <p className="text-xs text-dim">Pick a resource and read it. Every answer carries its own age.</p>}
          {read && !read.ok && (
            <p className="text-sm text-down" role="status">
              {read.error}{read.detail ? ` — ${read.detail}` : ""}
            </p>
          )}
          {read?.ok && (
            <>
              <p className="text-[11px] text-dim">
                {read.source} · {read.asOf ? ago(read.asOf) : "no timestamp"}
                {read.stale ? " · stale" : ""}
              </p>
              <Digest text={read.digest} />
              <button
                type="button"
                onClick={() => setShowRaw((s) => !s)}
                className="mt-2 text-[11px] text-dim underline decoration-dotted hover:text-accent"
              >
                {showRaw ? "hide" : "show"} structured data
              </button>
              {showRaw && (
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-line bg-bg p-2 font-mono text-[10px]">
                  {JSON.stringify(read.data, null, 2)}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default function Board() {
  const [reads, setReads] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [err, setErr] = useState(null);
  const [at, setAt] = useState(0);
  const [admin, setAdmin] = useState(false);

  const load = useCallback(async () => {
    try {
      const out = await readBoard(OVERVIEW);
      setReads(out.reads);
      setAt(out.at);
      setErr(null);
      // Both follow-ups are fire-and-forget: a slow or failing London archive
      // must not blank the part of the page that already answered.
      readBoard(WIDER)
        .then((w) => setReads((prev) => [...(prev || []), ...w.reads]))
        .catch(() => { /* the panels stay in their loading state */ });
      if (out.visibility === "admin") {
        const priv = await readBoard(PRIVATE);
        setReads((prev) => [...(prev || []), ...priv.reads]);
        setAdmin(true);
      }
    } catch (e) {
      setErr(String(e.message || e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    fetch("/api/board")
      .then((r) => r.json())
      .then((j) => setCatalog(j.resources || []))
      .catch(() => setCatalog([]));
  }, []);

  const byId = useMemo(() => {
    const m = new Map();
    for (const r of reads || []) if (!m.has(r.resource)) m.set(r.resource, r);
    return m;
  }, [reads]);
  const get = (id) => (reads ? byId.get(id) || { resource: id, ok: false, error: "not_read" } : null);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-1 flex items-center gap-2">
        <LayoutList className="h-5 w-5 text-accent" aria-hidden="true" />
        <h1 className="text-xl font-bold">Board</h1>
        <button
          type="button"
          onClick={load}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs text-dim transition-colors hover:border-accent hover:text-accent"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          {at ? ago(at) : "load"}
        </button>
      </div>
      <p className="mb-5 max-w-2xl text-sm text-dim">
        Everything the tool knows, from one place and in one request. Each panel is a resource from{" "}
        <Link to="/about" className="underline decoration-dotted hover:text-accent">the same catalog</Link>{" "}
        — it selects and aggregates rather than forwarding, so what you read here is a few hundred
        bytes instead of the ~270 KB the underlying endpoints return together. Anything that has
        gone quiet is labelled stale rather than shown as if it were current.
      </p>

      {err && (
        <p className="mb-4 text-sm text-down" role="status">
          The board is not answering ({err}).
        </p>
      )}

      <div className="mb-3"><Ask /></div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel read={get("argus.status")} title="Argus" />
        <Panel read={get("argus.positions")} title="Open positions" />
        <Panel read={get("argus.performance")} title="The book, by session" />
        <Panel read={get("kronos.state")} title="Kronos" />
        <Panel read={get("arena.state")} title="Arena" />
        <Panel read={get("market.quotes")} title="Market" />
        <Panel read={get("news.headlines")} title="Headlines" />
        <Panel read={get("news.telegram")} title="Telegram OSINT" />
        <Panel read={get("macro.yields")} title="US yield curve" />
        <Panel read={get("world.layers")} title="World layers" />
        <Panel read={get("world.hazards")} title="Hazards" className="lg:col-span-2" />
      </div>

      {admin && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold">
            Private <span className="font-normal text-dim">— visible to the dev account only</span>
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel read={get("cortex.state")} title="Cortex lab" />
            <Panel read={get("registry.strategies")} title="Registry" />
            <Panel read={get("portfolio.holdings")} title="Portfolio" />
            <Panel read={get("portfolio.watchlist")} title="Watchlist" />
            <Panel read={get("ml.track")} title="ML track record" className="lg:col-span-2" />
          </div>
        </>
      )}

      <div className="mt-6">
        {catalog.length > 0 && <Inspector catalog={catalog} />}
      </div>

      <p className="mt-6 text-xs text-dim">
        Read-only by design. Argus's command channel (close, cancel, reset) stays on{" "}
        <Link to="/argus" className="underline decoration-dotted hover:text-accent">its own page</Link>{" "}
        — an allowlist that only reads can be public; one that acts cannot.
      </p>
    </div>
  );
}
