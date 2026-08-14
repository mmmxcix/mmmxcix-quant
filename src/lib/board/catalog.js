// catalog.js — the board: one declared surface over everything the tool knows.
//
// WHAT THIS IS. Argus, Kronos, the arena, the monitor, the charts, the news and
// the bias each have their own endpoint, their own shape and their own units.
// Answering "what happened today" means visiting six of them and holding 270 KB
// of JSON in your head. The board declares each answerable thing ONCE — what it
// is, what it costs, who may see it, how stale it may be — and every surface
// (this page, the CLI, and later the chat) reads from the same declaration.
//
// WHAT IT IS NOT. It is not a proxy. A resource that returns its source verbatim
// has done nothing: the Argus snapshot alone is 171 KB now and ~620 KB at the
// 500-trade ledger cap. Every resource here SELECTS and AGGREGATES, and the
// aggregation reuses the modules the agents already use (learn.js, core.js) so
// the board can never quietly disagree with /argus about the same number.
//
// It is also READ-ONLY on purpose. Argus has a command channel (close, cancel,
// reset) and the board deliberately does not expose it. A read-only allowlist can
// be public; an action surface cannot, and mixing the two is how a convenience
// layer becomes an incident.
//
// THREE INVARIANTS, enforced by test/board.test.mjs:
//   1. Every resource declares `visibility`, inherited from what its source
//      already is today (Argus/Kronos/arena/news are public displays; prefs,
//      library and portfolio are admin-only and are NOT in this first wave).
//   2. No resource accepts a free-form key. Sources are named constants; the
//      /api/argus authorization bypass came from binding a caller's string into
//      a D1 lookup, and this layer multiplies that surface if it repeats it.
//   3. Every resource has a digest, and the digest of a full-size fixture stays
//      under a stated character budget.

import { ledgerStats, tradeR } from "../argus/core.js";
import { summarizeLedger, sessionOf } from "../argus/learn.js";
import { familyMix, payoffProfile } from "../payoff.js";
import { PANELS } from "../universe.js";
import { ArgError, coerceArgs, describeArgs } from "./args.js";
import { ago, block, clip, money, nf, pct, signedR, table, toMs } from "./format.js";

// ── sources ─────────────────────────────────────────────────────────────────
// A source is WHERE bytes come from, and it is a closed set. `d1` reads one
// fixed row of argus_kv by a key written here, never by anything a caller sent.
// `http` calls an endpoint this app already serves, so the board inherits its
// caching, its rate limit and its single implementation instead of forking one.
export const SOURCES = {
  argus: {
    kind: "d1",
    key: "snapshot",
    label: "Argus",
    // The agent persists every couple of minutes; a quarter hour of silence
    // means something is wrong on the PC, and the layer should say so.
    staleAfterMs: 15 * 60_000,
    asOf: (raw) => toMs(raw?.state?.at),
  },
  kronos: {
    kind: "d1",
    key: "kronos:snapshot",
    label: "Kronos",
    // Two runs a day (01:00 / 13:00), so a whole cycle plus slack.
    staleAfterMs: 14 * 3_600_000,
    asOf: (raw) => toMs(raw?.updatedAt),
  },
  arena: {
    kind: "d1",
    key: "arena:snapshot",
    label: "Arena",
    staleAfterMs: 30 * 60_000,
    asOf: (raw) => toMs(raw?.updatedAt),
  },
  news: {
    kind: "http",
    path: () => "/api/news",
    label: "News",
    staleAfterMs: 3 * 3_600_000,
    asOf: (raw) => toMs(raw?.meta?.fetchedAt),
  },
  quotes: {
    kind: "quotes", // fan-out over Binance + the /api/yahoo proxy, see the endpoint
    label: "Quotes",
    staleAfterMs: 10 * 60_000,
    asOf: (raw) => toMs(raw?.at),
  },
  candles: {
    kind: "candles",
    label: "Candles",
    staleAfterMs: 24 * 3_600_000,
    asOf: (raw) => toMs(raw?.at),
  },
  bias: {
    kind: "http",
    path: (a) => `/api/bias?symbol=${encodeURIComponent(a.symbol)}&market=${encodeURIComponent(a.market)}`,
    label: "Bias",
    staleAfterMs: 6 * 3_600_000,
    asOf: (raw) => toMs(raw?.at || raw?.cachedAt),
  },

  // ── wave 2 ────────────────────────────────────────────────────────────────
  // `auth: true` means the subrequest carries the caller's admin cookie, so the
  // gate stays where it already is (the source endpoint decides) instead of
  // being re-implemented here. The board still refuses an admin resource to a
  // public caller BEFORE fetching — two locks, and the inner one is the real one.
  // Note there is no single `lab` or `prefs` source taking a channel argument.
  // That would put a caller's string into the upstream query — the shape of the
  // bug this whole layer is built to avoid — so each channel is its own source
  // with a constant path, and `key`/`what` never appear as arguments at all.
  labState: {
    kind: "http", auth: true, path: () => "/api/lab",
    label: "Cortex lab", staleAfterMs: 2 * 3_600_000,
    asOf: (raw) => toMs(raw?.state?.at || raw?.state?.updatedAt),
  },
  labCandidates: {
    kind: "http", auth: true, path: () => "/api/lab?what=candidates",
    label: "Cortex candidates", staleAfterMs: 3 * 86_400_000,
    asOf: (raw) => Math.max(0, ...(raw?.candidates?.items || []).map((c) => toMs(c.at || c.foundAt))),
  },
  library: {
    kind: "http", auth: true, path: () => "/api/library",
    label: "Registry",
    staleAfterMs: 7 * 86_400_000, // a library is not a live feed; only a week of silence is odd
    asOf: (raw) => Math.max(0, ...(raw?.entries || []).map((e) => toMs(e.updatedAt || e.savedAt || e.createdAt))),
  },
  watchlist: {
    kind: "http", auth: true, path: () => "/api/prefs?key=watchlist",
    label: "Watchlist",
    staleAfterMs: 365 * 86_400_000, // kept by hand; it is never "stale"
    asOf: () => Date.now(),
  },
  // The cash model needs deposits as well as positions, so this source fetches
  // both constant paths and hands the pair over as one payload.
  holdings: {
    kind: "holdings", auth: true,
    label: "Portfolio", staleAfterMs: 365 * 86_400_000,
    asOf: () => Date.now(),
  },
  vol: {
    kind: "http",
    path: (a) => `/api/vol?symbol=${encodeURIComponent(a.symbol)}`,
    label: "Volatility",
    // The DoltHub snapshot syncs nightly; two days of silence means the job died.
    staleAfterMs: 2 * 86_400_000,
    asOf: (raw) => toMs(raw?.syncedAt),
  },
  telegram: {
    kind: "http",
    path: () => "/api/telegram",
    label: "Telegram OSINT",
    staleAfterMs: 3 * 3_600_000,
    asOf: (raw) => Math.max(0, ...(raw?.items || []).map((i) => toMs(i.time))),
  },

  // ── wave 3 ────────────────────────────────────────────────────────────────
  world: {
    kind: "http", path: () => "/api/world",
    label: "World layers",
    // The fleet agent bundles ships/planes/jamming into one ~3-minute write.
    staleAfterMs: 45 * 60_000,
    asOf: (raw) => toMs(raw?.at),
  },
  hazards: {
    kind: "hazards", // fires + conflicts: two constant paths, one payload
    label: "Hazards", staleAfterMs: 2 * 86_400_000,
    asOf: (raw) => Math.max(toMs(raw?.fires?.at), toMs(raw?.conflicts?.at)),
  },
  yields: {
    kind: "http",
    path: (a) => `/api/lse/bond-yields?country=${encodeURIComponent(a.country)}&format=json`,
    label: "London bond yields",
    staleAfterMs: 30 * 86_400_000, // an archive that lands in batches, not a feed
    asOf: (raw) => {
      const rows = raw?.data || raw?.rows || [];
      const last = rows[rows.length - 1];
      return last?.date ? toMs(Date.parse(last.date)) : 0;
    },
  },
  // The one source that is a real TABLE rather than a JSON blob — because a
  // blob that is overwritten every two minutes cannot have a history at all.
  // See db/board-tables.sql and functions/_lib/archive.mjs.
  history: {
    kind: "history",
    label: "Argus history",
    staleAfterMs: 60 * 60_000,
    asOf: (raw) => toMs(raw?.rows?.[raw.rows.length - 1]?.at),
  },
  mlmemory: {
    kind: "http", auth: true, path: () => "/api/mlmemory",
    label: "ML track record",
    staleAfterMs: 30 * 86_400_000,
    asOf: (raw) => Math.max(0, ...(raw?.preds || []).map((p) => toMs(p.madeAt))),
  },
};

// ── shared selection helpers ────────────────────────────────────────────────

const since = (rows, ms, field = "exitAt", now = Date.now()) =>
  ms == null ? rows : rows.filter((r) => toMs(r?.[field]) >= now - ms);

/** The ledger's 45 fields per row are for the agent; a reader needs twelve. */
const compactTrade = (c) => ({
  id: c.id,
  symbol: c.symbol,
  side: c.side,
  kind: c.kind,
  outcome: c.outcome,
  R: Number(tradeR(c).toFixed(3)),
  pnl: c.pnl,
  openedAt: toMs(c.openedAt),
  exitAt: toMs(c.exitAt),
  session: sessionOf(toMs(c.openedAt)),
  plannedR: c.plannedR,
  scores: c.scores || null, // the five setup components; null on trades that predate them
});

const statLine = (s) => `${s.n} trades · ${pct(s.winRate)} wins · Ø ${signedR(s.avgR)} · Σ ${signedR(s.sumR)}`;

/** How many rows any digest prints before it starts counting instead of listing. */
const DIGEST_ROWS = 40;

// ── resources ───────────────────────────────────────────────────────────────
// Wave 1 covers exactly what a trading day asks for: the three agents, the
// monitor, the charts, the news and the bias. Cortex/registry, the volatility
// snapshot, Telegram and the world layers are declared in docs/BOARD.md as wave 2
// and 3; they are the same two functions each and no new machinery.

/**
 * Each entry: what it answers, who may read it, which source it needs, the
 * closed argument schema, a pure `select(raw, args)` and a pure `digest(data)`.
 * @type {Record<string, {summary: string, visibility: "public"|"admin", source: keyof SOURCES, args: object, select: Function, digest: Function}>}
 */
export const RESOURCES = {
  // ── Argus ────────────────────────────────────────────────────────────────
  "argus.status": {
    summary: "Argus right now: equity, heat, open and forming setups, the daily pace, and whether it is halted.",
    visibility: "public",
    source: "argus",
    args: {},
    select(raw) {
      const s = raw?.state || {};
      return {
        equity: s.equity, markEquity: s.markEquity, unrealized: s.unrealized,
        dayPnl: s.dayPnl, dayPnlTotal: s.dayPnlTotal,
        open: s.open, forming: s.forming,
        // The second unit trap in this codebase, after ms-vs-seconds: `state.heatPct`
        // and `state.heatCapPct` are FRACTIONS (0.2 = 20%, see scripts/argus-agent.mjs
        // where heatPct = openRisk/equity), while `riskChecks.heatUsedPct` on a thesis
        // is already a percentage — same suffix, two units. /argus multiplies by 100 at
        // render time; the board normalises here, so `data` means what it says.
        heatPct: s.heatPct * 100, heatCapPct: s.heatCapPct * 100,
        portfolioLev: s.portfolioLev, portfolioLevCap: s.portfolioLevCap,
        pace: s.pace || null,
        halted: !!s.halted,
        universe: s.universe,
        learnRefusedPct: s.learnRefusedPct, learnConsidered: s.learnConsidered,
        at: toMs(s.at),
      };
    },
    digest(d, { now } = {}) {
      if (!d.at) return "Argus: no snapshot yet.";
      const p = d.pace;
      return block(
        `Argus · ${ago(d.at, now)}`,
        `Equity ${money(d.markEquity ?? d.equity)} · day ${money(d.dayPnl)} · unrealised ${money(d.unrealized)}`,
        `Heat ${nf(d.heatPct, 1)}% of ${nf(d.heatCapPct, 1)}% · leverage ${nf(d.portfolioLev, 2)}× of ${nf(d.portfolioLevCap, 1)}×`,
        `${d.open ?? 0} open · ${d.forming ?? 0} forming · ${d.universe ?? 0} instruments scanned`,
        p ? `Pace ${p.openedToday}/${p.maxPerDay} today, ${p.open}/${p.maxConcurrent} concurrent${p.blocked ? " — BLOCKED (no new entries)" : ""}` : null,
        d.halted ? "HALTED." : null,
      );
    },
  },

  "argus.positions": {
    summary: "The theses Argus holds open right now, with entry, stop, target and how far each has run.",
    visibility: "public",
    source: "argus",
    args: {},
    select(raw) {
      return (raw?.theses || [])
        .filter((t) => t.state === "open")
        .map((t) => ({
          id: t.id, symbol: t.symbol, side: t.side, kind: t.kind, timeframe: t.timeframe,
          entry: t.entry, stop: t.stop, target: t.target, currentPrice: t.currentPrice,
          plannedR: t.plannedR, unrealizedR: t.unrealizedR, unrealizedPnl: t.unrealizedPnl,
          maxFavR: t.maxFavR, maxAdvR: t.maxAdvR,
          openedAt: toMs(t.openedAt), reason: clip(t.reason, 200),
          scores: t.scores || null,
        }));
    },
    digest(d, { now } = {}) {
      if (!d.length) return "Argus holds no open position.";
      return block(
        `Argus · ${d.length} open`,
        table(
          ["symbol", "side", "kind", "entry", "now", "R", "best", "worst", "opened"],
          d.map((t) => [
            t.symbol, t.side, t.kind, nf(t.entry, 4), nf(t.currentPrice, 4),
            signedR(t.unrealizedR), signedR(t.maxFavR), signedR(t.maxAdvR), ago(t.openedAt, now),
          ]),
        ),
      );
    },
  },

  "argus.performance": {
    summary: "What the closed book actually did, optionally sliced by kind, symbol, side, session, source, bias or regime.",
    visibility: "public",
    source: "argus",
    args: {
      window: { type: "duration", default: "all", note: "how far back to count, e.g. 7d" },
      by: {
        type: "enum",
        values: ["overall", "kind", "symbol", "side", "session", "source", "bias", "regime"],
        default: "overall",
      },
      minN: { type: "int", default: 1, min: 1, max: 500, note: "hide buckets thinner than this" },
    },
    select(raw, a, { now = Date.now() } = {}) {
      const closed = since(raw?.ledger || [], a.window, "exitAt", now);
      const sum = summarizeLedger(closed);
      const overall = sum.overall;
      if (a.by === "overall") return { window: a.window, overall, buckets: null };
      const buckets = Object.entries(sum[a.by] || {})
        .filter(([, s]) => s.n >= a.minN)
        .sort((x, y) => y[1].sumR - x[1].sumR)
        .map(([key, s]) => ({ key, ...s }));
      return { window: a.window, overall, by: a.by, buckets };
    },
    digest(d) {
      if (!d.overall.n) return "No closed trades in this window.";
      return block(
        `Argus book · ${statLine(d.overall)} · t=${nf(d.overall.tStat, 2)}`,
        d.buckets && d.buckets.length
          ? block(
              `by ${d.by}:`,
              table(
                [d.by, "n", "wins", "Ø R", "Σ R", "t"],
                d.buckets.map((b) => [b.key, b.n, pct(b.winRate, 0), signedR(b.avgR), signedR(b.sumR), nf(b.tStat, 1)]),
              ),
            )
          : d.buckets
            ? `No bucket of ${d.by} reaches the minimum sample.`
            : null,
      );
    },
  },

  "argus.trades": {
    summary: "Individual closed trades, newest first, filterable by window, kind, symbol, side and outcome.",
    visibility: "public",
    source: "argus",
    args: {
      window: { type: "duration", default: "all" },
      kind: { type: "string", default: null, max: 32 },
      symbol: { type: "symbol", default: null },
      side: { type: "enum", values: ["long", "short"], default: null },
      outcome: { type: "enum", values: ["target", "stop", "invalidated", "timeout", "manual"], default: null },
      limit: { type: "int", default: 25, min: 1, max: 200 },
    },
    select(raw, a, { now = Date.now() } = {}) {
      let rows = since(raw?.ledger || [], a.window, "exitAt", now);
      if (a.kind) rows = rows.filter((c) => c.kind === a.kind);
      if (a.symbol) rows = rows.filter((c) => String(c.symbol).toUpperCase() === a.symbol);
      if (a.side) rows = rows.filter((c) => c.side === a.side);
      if (a.outcome) rows = rows.filter((c) => c.outcome === a.outcome);
      rows = rows.sort((x, y) => toMs(y.exitAt) - toMs(x.exitAt));
      const shown = rows.slice(0, a.limit).map(compactTrade);
      return { matched: rows.length, shown: shown.length, stats: ledgerStats(rows), trades: shown };
    },
    digest(d, { now } = {}) {
      if (!d.matched) return "No trade matches that filter.";
      // The digest is for reading; `data.trades` carries the full requested
      // slice. A 200-row table is a dump with a nicer name, so the text stops
      // at DIGEST_ROWS and says how many it left in the data.
      const rows = d.trades.slice(0, DIGEST_ROWS);
      return block(
        `${statLine(d.stats)} matching${d.shown < d.matched ? ` · showing ${d.shown}` : ""}`,
        table(
          ["symbol", "side", "kind", "session", "outcome", "R", "closed"],
          rows.map((t) => [t.symbol, t.side, t.kind, t.session, t.outcome, signedR(t.R), ago(t.exitAt, now)]),
        ),
        d.trades.length > rows.length ? `… ${d.trades.length - rows.length} more in the data.` : null,
      );
    },
  },

  "argus.lessons": {
    summary: "What the learning loop has concluded — the buckets it suppresses or resizes, with the evidence behind each.",
    visibility: "public",
    source: "argus",
    args: {
      verdict: { type: "enum", values: ["losing", "winning", "neutral"], default: null },
      limit: { type: "int", default: 20, min: 1, max: 50 },
    },
    select(raw, a) {
      const all = raw?.state?.lessons || [];
      const filtered = a.verdict ? all.filter((l) => l.verdict === a.verdict) : all;
      const rows = filtered.slice(0, a.limit);
      const counts = all.reduce((acc, l) => ({ ...acc, [l.verdict]: (acc[l.verdict] || 0) + 1 }), {});
      return {
        total: all.length,
        matched: filtered.length,
        verdict: a.verdict,
        counts,
        refusedPct: raw?.state?.learnRefusedPct ?? null,
        considered: raw?.state?.learnConsidered ?? null,
        lessons: rows,
        // The skills are the qualitative half — written by the LLM after a
        // review, kept across resets because they are earned knowledge.
        skills: (raw?.skills || []).map((s) => ({ scope: s.scope, lesson: clip(s.lesson, 240) })),
      };
    },
    digest(d) {
      if (!d.total) return "The learning loop has no lesson yet.";
      const c = d.counts;
      // Said explicitly, because the number is small and looks complete: this is
      // the agent's DISPLAY slice, not everything it learned. The live ledger
      // derives ~30 lessons and the sizing loop uses all of them.
      const head = `${d.total} lessons shown (the agent's display slice; sizing uses all of them) · ` +
        `${c.losing || 0} losing, ${c["strong-positive"] || c.winning || 0} favoured, ${c.neutral || 0} neutral` +
        (d.refusedPct != null ? ` · refuses ${nf(d.refusedPct, 0)}% of considered setups` : "");
      return block(
        head,
        // A filter that matches nothing is an answer and has to read like one —
        // an empty list under a header that still says "8 lessons" is not.
        d.matched === 0 ? `No lesson with verdict "${d.verdict}".` : null,
        d.lessons.map((l) => `· [${l.verdict}] ${clip(l.text, 160)}${l.n ? ` (n=${l.n})` : ""}`).join("\n"),
        d.skills.length ? block("Retained skills:", d.skills.map((s) => `· ${JSON.stringify(s.scope)} — ${s.lesson}`).join("\n")) : null,
      );
    },
  },

  "argus.journal": {
    summary: "Argus's own post-mortems: what it decided, what happened, and what it blamed.",
    visibility: "public",
    source: "argus",
    args: {
      window: { type: "duration", default: "7d" },
      symbol: { type: "symbol", default: null },
      limit: { type: "int", default: 15, min: 1, max: 60 },
    },
    select(raw, a, { now = Date.now() } = {}) {
      let rows = since(raw?.journal || [], a.window, "at", now);
      if (a.symbol) rows = rows.filter((j) => String(j.symbol).toUpperCase() === a.symbol);
      rows = rows.sort((x, y) => toMs(y.at) - toMs(x.at)).slice(0, a.limit);
      return {
        entries: rows.map((j) => ({
          at: toMs(j.at), symbol: j.symbol, kind: j.kind, side: j.side,
          outcome: j.outcome, R: j.R, verdict: j.verdict, cause: clip(j.cause, 260),
        })),
      };
    },
    digest(d, { now } = {}) {
      if (!d.entries.length) return "No journal entry in this window.";
      return d.entries
        .map((j) => `${ago(j.at, now)} · ${j.symbol} ${j.side} ${j.kind} → ${j.outcome} ${signedR(j.R)} [${j.verdict}]\n  ${j.cause}`)
        .join("\n");
    },
  },

  "argus.equity": {
    summary: "How the agent's equity, heat and exposure actually moved over a window — the one question the overwritten snapshot could never answer.",
    visibility: "public",
    source: "history",
    args: {
      window: { type: "duration", default: "7d" },
      points: { type: "int", default: 60, min: 5, max: 400, note: "downsampled evenly" },
    },
    select(raw, a) {
      const rows = (raw?.rows || []).map((r) => ({
        at: toMs(r.at),
        equity: r.mark_equity ?? r.equity,
        realised: r.equity,
        unrealized: r.unrealized,
        open: r.open_count,
        // Stored as the agent writes it (a fraction); converted here, once.
        heatPct: Number.isFinite(r.heat) ? r.heat * 100 : null,
        heatCapPct: Number.isFinite(r.heat_cap) ? r.heat_cap * 100 : null,
        lev: r.portfolio_lev,
        halted: !!r.halted,
      })).filter((r) => r.at);
      if (!rows.length) return { missing: !!raw?.missing, samples: 0, points: [] };

      const first = rows[0], last = rows[rows.length - 1];
      // Peak-to-trough on the recorded curve. Argus's own page rebuilds equity
      // from the closed ledger, which cannot see an open position's excursion —
      // this is the marked curve, so it can.
      let peak = -Infinity, maxDd = 0;
      for (const r of rows) {
        if (!Number.isFinite(r.equity)) continue;
        peak = Math.max(peak, r.equity);
        if (peak > 0) maxDd = Math.max(maxDd, (peak - r.equity) / peak);
      }
      const step = Math.max(1, Math.floor(rows.length / a.points));
      const points = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
      const heats = rows.map((r) => r.heatPct).filter(Number.isFinite);
      return {
        missing: false,
        samples: rows.length,
        from: first.at, to: last.at,
        startEquity: first.equity, endEquity: last.equity,
        changePct: first.equity > 0 ? ((last.equity - first.equity) / first.equity) * 100 : null,
        maxDrawdownPct: maxDd * 100,
        peakHeatPct: heats.length ? Math.max(...heats) : null,
        haltedSamples: rows.filter((r) => r.halted).length,
        points,
      };
    },
    digest(d, { now } = {}) {
      if (d.missing) {
        return "No history recorded yet — the archive table is created by the agent's next persist (see db/board-tables.sql).";
      }
      if (!d.samples) return "No history in this window.";
      return block(
        `Argus equity · ${d.samples} samples · ${ago(d.from, now)} → ${ago(d.to, now)}`,
        `${money(d.startEquity)} → ${money(d.endEquity)} (${nf(d.changePct, 2)}%)`,
        `Max drawdown ${nf(d.maxDrawdownPct, 2)}% on the marked curve · peak heat ${nf(d.peakHeatPct, 1)}%`,
        d.haltedSamples ? `Halted in ${d.haltedSamples} of ${d.samples} samples.` : null,
      );
    },
  },

  // ── Kronos ───────────────────────────────────────────────────────────────
  "kronos.state": {
    summary: "The Kronos forecast agent: its paper account, its forecast skill against a naive baseline, and its refusals.",
    visibility: "public",
    source: "kronos",
    args: { limit: { type: "int", default: 8, min: 1, max: 30, note: "journal entries" } },
    select(raw, a) {
      const acc = raw?.account || null;
      return {
        updatedAt: toMs(raw?.updatedAt),
        scoredCount: raw?.scoredCount || 0,
        scoreboard: raw?.scoreboard || [],
        forecasts: (raw?.forecasts || []).map((f) => ({
          symbol: f.symbol, interval: f.interval, model: f.model,
          at: toMs(f.at), lastClose: f.lastClose, bars: (f.forecast || []).length,
          // The forecast's own direction, so a reader does not have to walk the bars.
          impliedPct: f.forecast?.length && f.lastClose
            ? ((f.forecast[f.forecast.length - 1].close - f.lastClose) / f.lastClose) * 100
            : null,
        })),
        account: acc && {
          budget: acc.budget, equity: acc.equity, returnPct: acc.returnPct,
          n: acc.n, wins: acc.wins, winRate: acc.winRate, avgR: acc.avgR,
          tStat: acc.tStat, maxDrawdownPct: acc.maxDrawdownPct,
          startedAt: toMs(acc.startedAt), // Python writes seconds; the layer normalises
          open: (acc.open || []).length, closed: (acc.closed || []).length,
        },
        journal: (raw?.account?.journal || []).slice(-a.limit).reverse()
          .map((j) => ({ at: toMs(j.at), symbol: j.symbol, action: j.action, detail: clip(j.detail, 200) })),
      };
    },
    digest(d, { now } = {}) {
      if (!d.updatedAt) return "Kronos has not reported yet.";
      const a = d.account;
      return block(
        `Kronos · ${ago(d.updatedAt, now)} · ${d.scoredCount} forecasts graded`,
        a ? `Paper ${money(a.equity)} of ${money(a.budget)} (${nf(a.returnPct, 2)}%) · ${a.n} closed, ${a.open} open` : null,
        d.forecasts.length
          ? table(["symbol", "model", "last", "implied", "made"],
              d.forecasts.map((f) => [f.symbol, f.model, nf(f.lastClose, 2), `${nf(f.impliedPct, 2)}%`, ago(f.at, now)]))
          : "No live forecast.",
        d.scoreboard.length
          ? table(["symbol", "n", "beat naive", "skill", "direction"],
              d.scoreboard.map((s) => [s.symbol, s.n, `${nf(s.beatNaivePct, 0)}%`, `${nf(s.avgSkillPct, 1)}%`, `${nf(s.directionPct, 0)}%`]))
          : "Scoreboard empty — no forecast has reached its horizon yet.",
        d.journal.length ? block("Latest decisions (refusals included):",
          d.journal.map((j) => `· ${ago(j.at, now)} ${j.symbol} ${j.action} — ${j.detail}`).join("\n")) : null,
      );
    },
  },

  // ── Arena ────────────────────────────────────────────────────────────────
  "arena.state": {
    summary: "Live paper trading for strategies that cannot be backtested, and the order-book estimators' scoreboard.",
    visibility: "public",
    source: "arena",
    args: {},
    select(raw) {
      return {
        updatedAt: toMs(raw?.updatedAt),
        entries: (raw?.entries || []).map((e) => ({
          id: e.id, label: e.label, symbol: e.symbol, status: e.status,
          startedAt: toMs(e.startedAt), modelCoverage: e.modelCoverage,
          stats: e.verdict?.stats || null, reason: clip(e.verdict?.reason, 200),
          openTrades: (e.ledger || []).filter((t) => t.state === "open").length,
          closedTrades: (e.ledger || []).filter((t) => t.state !== "open").length,
        })),
        scores: raw?.scores || null,
      };
    },
    digest(d, { now } = {}) {
      if (!d.updatedAt) return "The arena has not reported yet.";
      return block(
        `Arena · ${ago(d.updatedAt, now)} · ${d.entries.length} entrants`,
        table(["strategy", "status", "n", "Ø R", "t", "open"],
          d.entries.map((e) => [
            clip(e.label, 34), e.status, e.stats?.n ?? 0,
            signedR(e.stats?.avgR), nf(e.stats?.tStat, 1), e.openTrades,
          ])),
        d.entries.filter((e) => e.reason).map((e) => `· ${clip(e.label, 28)}: ${e.reason}`).join("\n"),
      );
    },
  },

  // ── market ───────────────────────────────────────────────────────────────
  "market.quotes": {
    summary: "The monitor: price and day change for one panel of the instrument universe, or for named symbols.",
    visibility: "public",
    source: "quotes",
    args: {
      panel: { type: "enum", values: ["all", ...PANELS.map((p) => p.id)], default: "crypto" },
      symbols: { type: "list", of: { type: "symbol" }, max: 20, default: null, note: "overrides panel" },
    },
    select(raw) {
      const rows = (raw?.quotes || []).map((q) => ({
        symbol: q.symbol, name: q.name, market: q.market, price: q.price, changePct: q.changePct,
      }));
      const ok = rows.filter((r) => Number.isFinite(r.price));
      return { at: toMs(raw?.at), quotes: rows, missing: rows.length - ok.length };
    },
    digest(d, { now } = {}) {
      if (!d.quotes.length) return "No instrument in this selection.";
      return block(
        `Market · ${ago(d.at, now)}`,
        table(["instrument", "price", "day"],
          d.quotes.map((q) => [
            q.name || q.symbol,
            Number.isFinite(q.price) ? nf(q.price, q.price >= 1000 ? 0 : q.price >= 1 ? 2 : 5) : "—",
            Number.isFinite(q.changePct) ? `${q.changePct >= 0 ? "+" : "−"}${nf(Math.abs(q.changePct), 2)}%` : "—",
          ])),
        d.missing ? `${d.missing} quote(s) unavailable — reported rather than hidden.` : null,
      );
    },
  },

  "market.candles": {
    summary: "OHLC history for one instrument, with the plain facts a reader wants first: range, change, and current volatility.",
    visibility: "public",
    source: "candles",
    args: {
      symbol: { type: "symbol", required: true },
      market: { type: "enum", values: ["crypto", "stock"], default: "crypto" },
      interval: { type: "enum", values: ["5m", "15m", "1h", "4h", "1d", "1wk"], default: "1d" },
      range: { type: "enum", values: ["5d", "1mo", "3mo", "6mo", "1y", "2y", "5y"], default: "3mo" },
      bars: { type: "int", default: 60, min: 5, max: 400, note: "how many bars come back in `data`" },
    },
    select(raw, a) {
      const all = raw?.candles || [];
      const rows = all.slice(-a.bars);
      const first = rows[0], last = rows[rows.length - 1];
      const highs = rows.map((c) => c.high), lows = rows.map((c) => c.low);
      // True range as a share of price — the same volatility notion the agents
      // gate on (core.js volStatus), so a reader compares like with like.
      const trs = rows.slice(1).map((c, i) => {
        const p = rows[i];
        return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      });
      const atr = trs.length ? trs.slice(-14).reduce((x, y) => x + y, 0) / Math.min(14, trs.length) : null;
      return {
        symbol: a.symbol, market: a.market, interval: a.interval, range: a.range,
        at: toMs(raw?.at), bars: rows.length, available: all.length,
        first: first || null, last: last || null,
        changePct: first && last ? ((last.close - first.open) / first.open) * 100 : null,
        high: highs.length ? Math.max(...highs) : null,
        low: lows.length ? Math.min(...lows) : null,
        atr, atrPct: atr && last ? (atr / last.close) * 100 : null,
        candles: rows,
      };
    },
    digest(d) {
      if (!d.bars) return `No candles for ${d.symbol}.`;
      return block(
        `${d.symbol} · ${d.interval} · ${d.bars} bars`,
        `Last ${nf(d.last.close, 4)} · window ${nf(d.changePct, 2)}% · high ${nf(d.high, 4)} · low ${nf(d.low, 4)}`,
        `ATR(14) ${nf(d.atr, 4)} = ${nf(d.atrPct, 2)}% of price`,
      );
    },
  },

  "market.bias": {
    summary: "The fundamental/news bias for one instrument — the deterministic score plus, when a provider is configured, one synthesised sentence.",
    visibility: "public",
    source: "bias",
    args: {
      symbol: { type: "symbol", required: true },
      market: { type: "enum", values: ["crypto", "stock"], default: "stock" },
    },
    select(raw, a) {
      return {
        symbol: a.symbol,
        market: a.market,
        hasLLM: !!raw?.hasLLM,
        note: raw?.note ?? null,
        horizon: raw?.horizon || null,   // { short, medium, long } → "long" | "short" | "neutral"
        targets: raw?.targets || null,
        anchorPrice: raw?.anchorPrice ?? null,
        confidence: raw?.confidence ?? null,
        drivers: Array.isArray(raw?.drivers) ? raw.drivers.map((x) => clip(x, 160)) : [],
        model: raw?.model || null,
        cached: !!raw?.cached,
      };
    },
    digest(d) {
      if (!d.hasLLM) {
        return `Bias · ${d.symbol}: no synthesised read (no provider configured, or the endpoint declined). The deterministic fundamental score on /charts is unaffected.`;
      }
      const h = d.horizon || {};
      const t = d.targets || {};
      const arrow = (k) => `${k} ${h[k] || "—"}${Number.isFinite(t[k]) ? ` → ${nf(t[k], 2)}` : ""}`;
      return block(
        `Bias · ${d.symbol}${d.anchorPrice ? ` · anchored at ${nf(d.anchorPrice, 2)}` : ""} · confidence ${nf(d.confidence, 2)}${d.cached ? " · cached" : ""}`,
        d.note,
        `${arrow("short")} · ${arrow("medium")} · ${arrow("long")}`,
        d.drivers.length ? d.drivers.map((x) => `· ${x}`).join("\n") : null,
      );
    },
  },

  // ── news ─────────────────────────────────────────────────────────────────
  "news.headlines": {
    summary: "Aggregated finance headlines, filterable by category, source tier, text and age — plus which feeds are actually alive.",
    visibility: "public",
    source: "news",
    args: {
      category: { type: "enum", values: ["markets", "crypto", "business"], default: null },
      tier: { type: "int", default: null, min: 1, max: 2, note: "1 = primary sources, 2 = mainstream desks" },
      // Tier 1 deliberately holds government releases AND company press-release
      // wires — both are primary. This is the axis that separates them, which
      // "tier 1" alone cannot: asking for the market movers should not return a
      // corporate award announcement.
      kind: { type: "enum", values: ["official", "press", "media"], default: null },
      q: { type: "string", default: null, max: 60, note: "case-insensitive substring of title or description" },
      window: { type: "duration", default: "24h" },
      limit: { type: "int", default: 20, min: 1, max: 100 },
    },
    select(raw, a, { now = Date.now() } = {}) {
      let items = raw?.items || [];
      if (a.category) items = items.filter((i) => i.category === a.category);
      if (a.tier) items = items.filter((i) => i.tier === a.tier);
      if (a.kind) items = items.filter((i) => (i.kind || (i.tier === 1 ? "official" : "media")) === a.kind);
      if (a.q) {
        const q = a.q.toLowerCase();
        items = items.filter((i) => `${i.title} ${i.description || ""}`.toLowerCase().includes(q));
      }
      const dated = items
        .map((i) => ({ ...i, at: toMs(Date.parse(i.pubDate)) }))
        .filter((i) => (a.window == null ? true : i.at >= now - a.window))
        .sort((x, y) => y.at - x.at);
      const feeds = raw?.meta?.feeds || [];
      return {
        matched: dated.length,
        items: dated.slice(0, a.limit).map((i) => ({
          title: i.title, source: i.source, category: i.category, tier: i.tier,
          kind: i.kind || (i.tier === 1 ? "official" : "media"),
          at: i.at, link: i.link, description: clip(i.description, 220),
        })),
        feedsLive: feeds.filter((f) => f.ok).length,
        feedsTotal: feeds.length,
        feedsDown: feeds.filter((f) => !f.ok).map((f) => f.source),
      };
    },
    digest(d, { now } = {}) {
      if (!d.matched) return "No headline matches that filter in this window.";
      return block(
        `${d.matched} headlines · ${d.feedsLive}/${d.feedsTotal} feeds live` +
          (d.feedsDown.length ? ` · down: ${d.feedsDown.join(", ")}` : ""),
        d.items.map((i) => `· [${i.source}] ${clip(i.title, 120)} (${ago(i.at, now)})`).join("\n"),
      );
    },
  },

  "news.telegram": {
    summary: "Public Telegram OSINT channels — faster than the wires, and unverified, which is the trade.",
    visibility: "public",
    source: "telegram",
    args: {
      tag: { type: "enum", values: ["crypto", "finance", "breaking", "geo"], default: null },
      window: { type: "duration", default: "6h" },
      limit: { type: "int", default: 20, min: 1, max: 60 },
    },
    select(raw, a, { now = Date.now() } = {}) {
      let items = (raw?.items || []).map((i) => ({ ...i, at: toMs(i.time) }));
      if (a.tag) items = items.filter((i) => i.tag === a.tag);
      const inWindow = a.window == null ? items : items.filter((i) => i.at >= now - a.window);
      const sorted = inWindow.sort((x, y) => y.at - x.at);
      return {
        matched: sorted.length,
        channels: [...new Set((raw?.items || []).map((i) => i.channel))],
        items: sorted.slice(0, a.limit).map((i) => ({
          channel: i.channel, tag: i.tag, at: i.at, url: i.url, text: clip(i.text, 240),
        })),
      };
    },
    digest(d, { now } = {}) {
      if (!d.matched) return "No Telegram post in this window.";
      return block(
        `${d.matched} posts from ${d.channels.length} channels — UNVERIFIED OSINT, fast but not authoritative`,
        d.items.map((i) => `· [${i.channel}] ${i.text} (${ago(i.at, now)})`).join("\n"),
      );
    },
  },

  // ── volatility ───────────────────────────────────────────────────────────
  "vol.iv": {
    summary: "Implied vs realised volatility for one symbol: IV rank, percentile, the premium and the 52-week extremes.",
    visibility: "public",
    source: "vol",
    args: { symbol: { type: "symbol", required: true } },
    select(raw, a) {
      return {
        symbol: a.symbol,
        found: Number.isFinite(raw?.iv) && raw.iv > 0,
        date: raw?.date || null,
        syncedAt: toMs(raw?.syncedAt),
        universe: raw?.universe ?? null,
        iv: raw?.iv ?? null, hv: raw?.hv ?? null,
        ivPremium: raw?.ivPremium ?? null,
        ivRank: raw?.ivRank ?? null,
        crossPercentile: raw?.crossPercentile ?? null,
        yearHigh: raw?.yearHigh ?? null, yearHighDate: raw?.yearHighDate || null,
        yearLow: raw?.yearLow ?? null, yearLowDate: raw?.yearLowDate || null,
        ivWeekAgo: raw?.ivWeekAgo ?? null, ivMonthAgo: raw?.ivMonthAgo ?? null,
      };
    },
    digest(d) {
      if (!d.found) return `No options data for ${d.symbol} in the snapshot of ${d.date || "—"} (${d.universe ?? 0} symbols).`;
      return block(
        `${d.symbol} volatility · snapshot ${d.date}`,
        `IV ${pct(d.iv)} vs realised ${pct(d.hv)} · premium ${nf(d.ivPremium, 2)}×`,
        `IV rank ${nf(d.ivRank, 0)} of 100 · cross-sectional percentile ${nf(d.crossPercentile, 0)}`,
        `52w range ${pct(d.yearLow)} (${d.yearLowDate}) … ${pct(d.yearHigh)} (${d.yearHighDate})`,
        Number.isFinite(d.ivWeekAgo) && d.ivWeekAgo > 0 ? `A week ago IV was ${pct(d.ivWeekAgo)}.` : null,
      );
    },
  },

  // ── Cortex (admin) ───────────────────────────────────────────────────────
  "cortex.state": {
    summary: "The Cortex lab agent: its paper book, how many strategies it runs, and whether the RiskGate is armed.",
    visibility: "admin",
    source: "labState",
    args: {},
    select(raw) {
      const s = raw?.state || null;
      const rg = s?.riskgate || null;
      const strategies = Array.isArray(s?.strategies) ? s.strategies : [];
      return {
        reporting: !!s,
        at: toMs(s?.at || s?.updatedAt),
        combined: s?.combined || null,
        strategies: strategies.length,
        failing: strategies.filter((x) => x.error).length,
        riskgate: rg && {
          armed: !!rg.armed,
          openPositions: rg.activeLimits?.openPositions ?? null,
          maxPositions: rg.rules?.maxSimultaneousPositions ?? null,
          drawdownPct: rg.activeLimits?.combinedDrawdownPct ?? null,
          profiles: rg.byProfile ? Object.keys(rg.byProfile) : null,
        },
      };
    },
    digest(d, { now } = {}) {
      if (!d.reporting) return "The lab agent has not reported — it runs on the PC, so this usually means the fleet is off.";
      const c = d.combined, rg = d.riskgate;
      return block(
        `Cortex lab${d.at ? ` · ${ago(d.at, now)}` : ""}`,
        c ? `Combined ${money(c.equity, "USD")} (${nf(c.returnPct, 2)}%)` : "No combined book reported.",
        `${d.strategies} strategies in the virtual book${d.failing ? ` · ${d.failing} erroring` : ""}`,
        rg
          ? `RiskGate ${rg.armed ? "ARMED (fails closed)" : "idle"} · ${rg.openPositions ?? "—"}/${rg.maxPositions ?? "—"} positions · drawdown ${nf(rg.drawdownPct, 1)}%`
          : "No RiskGate report.",
      );
    },
  },

  "cortex.candidates": {
    summary: "Research survivors the lab agent pushed up — what Cortex found and thought worth keeping.",
    visibility: "admin",
    source: "labCandidates",
    args: { limit: { type: "int", default: 15, min: 1, max: 60 } },
    select(raw, a) {
      const items = raw?.candidates?.items || raw?.candidates || [];
      const list = (Array.isArray(items) ? items : []).slice(0, a.limit);
      return {
        total: Array.isArray(items) ? items.length : 0,
        items: list.map((c) => ({
          id: c.id, name: c.name || c.title || c.id,
          symbol: c.symbol, market: c.market, interval: c.interval,
          at: toMs(c.at || c.foundAt),
          source: c.research?.source || c.source || null,
          metrics: c.metrics
            ? { trades: c.metrics.tradeCount, winRatePct: c.metrics.winRatePct, sharpe: c.metrics.sharpe, returnPct: c.metrics.returnPct }
            : null,
        })),
      };
    },
    digest(d, { now } = {}) {
      if (!d.total) return "No research candidate stored. Cortex is measured as only ever seeing paper abstracts — see docs/HANDOFF.md.";
      return block(
        `${d.total} candidates`,
        table(["name", "symbol", "trades", "win", "return", "found"],
          d.items.map((c) => [
            clip(c.name, 30), c.symbol || "—",
            c.metrics?.trades ?? "—",
            c.metrics?.winRatePct != null ? `${nf(c.metrics.winRatePct, 0)}%` : "—",
            c.metrics?.returnPct != null ? `${nf(c.metrics.returnPct, 1)}%` : "—",
            ago(c.at, now),
          ])),
      );
    },
  },

  // ── registry (admin) ─────────────────────────────────────────────────────
  "registry.strategies": {
    summary: "The strategy library by lifecycle status, each entry with its inferred payoff shape and the win/loss ratio it must beat.",
    visibility: "admin",
    source: "library",
    args: {
      status: { type: "enum", values: ["factory", "validated", "paper", "improve", "graveyard"], default: null },
      family: { type: "enum", values: ["reversion", "momentum", "carry", "mixed", "unknown"], default: null },
      limit: { type: "int", default: 20, min: 1, max: 100 },
    },
    select(raw, a) {
      const all = (raw?.entries || []).map((e) => ({
        id: e.id, name: e.name, symbol: e.symbol, market: e.market,
        interval: e.interval, status: e.status || "factory",
        crowned: !!e.crowned,
        updatedAt: toMs(e.updatedAt || e.savedAt || e.createdAt),
        metrics: e.metrics
          ? { trades: e.metrics.tradeCount, winRatePct: e.metrics.winRatePct, profitFactor: e.metrics.profitFactor, returnPct: e.metrics.returnPct, sharpe: e.metrics.sharpe }
          : null,
        payoff: payoffProfile(e.metrics),
      }));
      let rows = all;
      if (a.status) rows = rows.filter((e) => e.status === a.status);
      if (a.family) rows = rows.filter((e) => e.payoff.family === a.family);
      rows = rows.sort((x, y) => y.updatedAt - x.updatedAt);
      const byStatus = all.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] || 0) + 1 }), {});
      return {
        total: all.length,
        matched: rows.length,
        byStatus,
        mix: familyMix(all),
        entries: rows.slice(0, a.limit),
      };
    },
    digest(d) {
      if (!d.total) return "The library is empty.";
      const statuses = Object.entries(d.byStatus).map(([k, v]) => `${v} ${k}`).join(" · ");
      const mix = d.mix?.counts
        ? Object.entries(d.mix.counts).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(", ")
        : null;
      return block(
        `${d.total} strategies · ${statuses}`,
        mix ? `Payoff shapes: ${mix}` : null,
        // familyMix says so when a whole library is one bet in several costumes;
        // that warning is the reason the shapes are recorded at all.
        d.mix?.warning || null,
        d.matched
          ? table(["name", "status", "shape", "n", "ratio", "must beat"],
              d.entries.slice(0, DIGEST_ROWS).map((e) => [
                clip(e.name, 28), e.status, e.payoff.family,
                e.payoff.trades,
                e.payoff.payoffRatio ?? "—",
                e.payoff.breakEvenRatio ?? "—",
              ]))
          : "No entry matches that filter.",
      );
    },
  },

  // ── portfolio (admin) ────────────────────────────────────────────────────
  "portfolio.watchlist": {
    summary: "The symbols you actually follow — the same list the news digest and the briefing read.",
    visibility: "admin",
    source: "watchlist",
    args: {},
    select(raw) {
      const list = Array.isArray(raw?.data) ? raw.data : [];
      return { count: list.length, entries: list.map((e) => ({ market: e.market, symbol: e.symbol, name: e.name })) };
    },
    digest(d) {
      if (!d.count) return "The watchlist is empty.";
      return block(
        `${d.count} symbols`,
        d.entries.map((e) => `· ${e.symbol} — ${e.name || ""} (${e.market})`).join("\n"),
      );
    },
  },

  "portfolio.holdings": {
    summary: "The simulated portfolio: open and closed positions, cost basis, and cash derived from deposits rather than stored.",
    visibility: "admin",
    source: "holdings",
    args: { includeClosed: { type: "bool", default: false } },
    select(raw, a) {
      const positions = Array.isArray(raw?.portfolio) ? raw.portfolio : [];
      const deposits = Array.isArray(raw?.deposits) ? raw.deposits : [];
      const open = positions.filter((p) => p.sellPrice == null);
      const closed = positions.filter((p) => p.sellPrice != null);
      // Cash is DERIVED, never stored (see src/lib/portfolio.js): deposits minus
      // buys plus realised sells. Recomputing it here keeps the board consistent
      // with the page under edits and deletes, exactly as that module intends.
      const depositUSD = deposits.reduce((a2, d) => a2 + (Number(d.usd) || 0), 0);
      const bought = positions.reduce((a2, p) => a2 + (Number(p.shares) || 0) * (Number(p.avgPrice) || 0), 0);
      const sold = closed.reduce((a2, p) => a2 + (Number(p.shares) || 0) * (Number(p.sellPrice) || 0), 0);
      const realised = closed.reduce((a2, p) => a2 + (Number(p.shares) || 0) * ((Number(p.sellPrice) || 0) - (Number(p.avgPrice) || 0)), 0);
      return {
        deposited: depositUSD,
        cashUSD: depositUSD - bought + sold,
        costBasisOpen: open.reduce((a2, p) => a2 + (Number(p.shares) || 0) * (Number(p.avgPrice) || 0), 0),
        realisedPnl: realised,
        openCount: open.length,
        closedCount: closed.length,
        positions: (a.includeClosed ? positions : open).map((p) => ({
          symbol: p.symbol, name: p.name, market: p.market,
          shares: p.shares, avgPrice: p.avgPrice,
          sellPrice: p.sellPrice ?? null,
          addedAt: toMs(p.addedAt), buyDate: toMs(p.buyDate),
        })),
      };
    },
    digest(d) {
      if (!d.openCount && !d.closedCount) return "No position recorded. Deposits and positions live under /portfolio.";
      return block(
        `Portfolio · ${d.openCount} open, ${d.closedCount} closed`,
        `Deposited ${money(d.deposited, "USD")} · cash ${money(d.cashUSD, "USD")} · cost basis ${money(d.costBasisOpen, "USD")} · realised ${money(d.realisedPnl, "USD")}`,
        d.positions.length
          ? table(["symbol", "shares", "avg", "sold at"],
              d.positions.slice(0, DIGEST_ROWS).map((p) => [
                p.symbol, nf(p.shares, 4), nf(p.avgPrice, 2), p.sellPrice != null ? nf(p.sellPrice, 2) : "—",
              ]))
          : null,
        // Marks are deliberately absent: quoting them here would mean a second
        // price path next to market.quotes, and two of those disagree eventually.
        "Market value is not shown — ask market.quotes for the marks.",
      );
    },
  },

  // ── the world (wave 3) ───────────────────────────────────────────────────
  "world.layers": {
    summary: "The live map layers — aircraft, ships and GPS jamming — as counts, plus which layer is not reporting.",
    visibility: "public",
    source: "world",
    args: {},
    select(raw) {
      // The agent ships these as positional arrays to keep the KV write small;
      // the board counts them rather than re-encoding thousands of rows.
      const planes = raw?.planes || [];
      const ships = raw?.ships || [];
      const jamming = raw?.jamming || [];
      return {
        at: toMs(raw?.at),
        planes: planes.length,
        ships: ships.length,
        jamming: jamming.length,
        // A layer at exactly zero is the interesting case: it means an ingest is
        // broken or a key is missing, and counting it as "quiet" would hide that.
        empty: [
          planes.length ? null : "planes",
          ships.length ? null : "ships",
          jamming.length ? null : "jamming",
        ].filter(Boolean),
      };
    },
    digest(d, { now } = {}) {
      if (!d.at) return "The world agent has not reported.";
      return block(
        `World · ${ago(d.at, now)}`,
        `${d.planes} aircraft · ${d.ships} ships · ${d.jamming} jamming reports`,
        d.empty.length
          ? `Not reporting: ${d.empty.join(", ")}. An empty layer is an ingest that stopped, not a quiet world — ships need the aisstream key.`
          : null,
      );
    },
  },

  "world.hazards": {
    summary: "Fires and armed-conflict events worldwide: totals, the worst readings and which countries dominate them.",
    visibility: "public",
    source: "hazards",
    args: { top: { type: "int", default: 6, min: 1, max: 20 } },
    select(raw, a) {
      // fires:     [lat, lon, frp]                         (frp = radiative power, MW)
      // conflicts: [lat, lon, fatalities, events, date, country, actor1, actor2]
      const fires = raw?.fires?.fires || [];
      const conflicts = raw?.conflicts?.conflicts || [];
      const byCountry = new Map();
      let fatalities = 0;
      for (const c of conflicts) {
        const country = c[5] || "unknown";
        const dead = Number(c[2]) || 0;
        fatalities += dead;
        const e = byCountry.get(country) || { country, events: 0, fatalities: 0 };
        e.events += 1; e.fatalities += dead;
        byCountry.set(country, e);
      }
      const frps = fires.map((f) => Number(f[2]) || 0);
      return {
        firesAt: toMs(raw?.fires?.at),
        conflictsAt: toMs(raw?.conflicts?.at),
        fireCount: raw?.fires?.count ?? fires.length,
        fireShown: fires.length,
        hottestFrp: frps.length ? Math.max(...frps) : null,
        conflictCount: raw?.conflicts?.count ?? conflicts.length,
        conflictShown: conflicts.length,
        fatalities,
        topCountries: [...byCountry.values()].sort((x, y) => y.fatalities - x.fatalities).slice(0, a.top),
      };
    },
    digest(d, { now } = {}) {
      if (!d.fireCount && !d.conflictCount) return "No hazard data — neither agent has pushed a snapshot.";
      return block(
        `Fires ${d.fireCount} detections${d.hottestFrp ? ` · hottest ${nf(d.hottestFrp, 0)} MW` : ""} (${ago(d.firesAt, now)})`,
        `Conflict events ${d.conflictCount} · ${d.fatalities} fatalities in the ${d.conflictShown} shown (${ago(d.conflictsAt, now)})`,
        d.topCountries.length
          ? table(["country", "events", "fatalities"], d.topCountries.map((c) => [c.country, c.events, c.fatalities]))
          : null,
        // Said once, so nobody reads a lagging archive as today's news.
        "ACLED events are an archive with a reporting lag; the date column is the event date, not the filing date.",
      );
    },
  },

  // ── macro (wave 3) ───────────────────────────────────────────────────────
  "macro.yields": {
    summary: "Government bond yields for one country from the London archive — the latest curve and how it moved.",
    visibility: "public",
    source: "yields",
    args: {
      country: { type: "enum", values: ["US", "DE", "GB", "CH", "JP", "FR", "IT", "AU", "CA"], default: "US" },
      lookbackDays: { type: "int", default: 90, min: 5, max: 730 },
    },
    select(raw, a) {
      const rows = (raw?.data || raw?.rows || []).map((r) => ({
        date: r.date, tenor: String(r.maturity || r.tenor || ""), days: Number(r.maturity_days ?? r.days) || 0,
        close: Number(r.close),
      })).filter((r) => Number.isFinite(r.close) && r.date && r.tenor);
      if (!rows.length) return { country: a.country, found: false, curve: [], real: [], asOfDate: null };

      // TIPS are INFLATION-LINKED: a real yield, not a nominal one. The first
      // version of this let "10Y TIPS" stand in for the missing nominal 10Y and
      // printed "2s10s −192 bp — inverted", which is not a curve inversion but
      // two different instruments subtracted from each other. They are kept, and
      // kept apart.
      const isReal = (t) => /TIPS|INDEX|LINK|REAL/i.test(t);
      const asOfDate = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date);
      const cutoff = new Date(new Date(asOfDate).getTime() - a.lookbackDays * 86_400_000)
        .toISOString().slice(0, 10);

      // Latest observation PER TENOR, not "everything printed on the last day":
      // bond series skip tenors on individual days, and a curve that silently
      // drops the 10Y is how the wrong spread got computed in the first place.
      const latest = new Map(), past = new Map();
      for (const r of rows) {
        const l = latest.get(r.tenor);
        if (!l || r.date > l.date) latest.set(r.tenor, r);
        if (r.date <= cutoff) {
          const p = past.get(r.tenor);
          if (!p || r.date > p.date) past.set(r.tenor, r);
        }
      }
      const shape = (r) => ({
        tenor: r.tenor, days: r.days, close: r.close, date: r.date,
        lagging: r.date !== asOfDate, // this tenor did not print on the latest day
        changeBp: past.has(r.tenor) ? (r.close - past.get(r.tenor).close) * 100 : null,
      });
      const all = [...latest.values()].sort((x, y) => x.days - y.days);
      const curve = all.filter((r) => !isReal(r.tenor)).map(shape);
      const real = all.filter((r) => isReal(r.tenor)).map(shape);

      const pick = (d) => curve.find((c) => Math.abs(c.days - d) <= 40) || null;
      const two = pick(730), ten = pick(3650);
      const bothFresh = two && ten && !two.lagging && !ten.lagging;
      return {
        country: a.country, found: true, asOfDate, observations: rows.length,
        curve, real,
        spread2s10s: two && ten ? (ten.close - two.close) * 100 : null,
        // Why the number may be absent or soft — stated, not implied.
        spreadNote: !two || !ten
          ? `no nominal ${!two ? "2Y" : "10Y"} in this archive`
          : bothFresh ? null : `2Y as of ${two.date}, 10Y as of ${ten.date}`,
      };
    },
    digest(d) {
      if (!d.found) return `No yield data for ${d.country} (the London archive may not be configured — LSE_API_KEY).`;
      return block(
        `${d.country} government yields · latest ${d.asOfDate}`,
        table(["tenor", "yield %", "Δ bp", "as of"],
          d.curve.map((c) => [c.tenor, nf(c.close, 3), c.changeBp == null ? "—" : nf(c.changeBp, 0), c.lagging ? c.date : ""])),
        d.spread2s10s != null
          ? `2s10s ${nf(d.spread2s10s, 0)} bp${d.spread2s10s < 0 ? " — inverted" : ""}${d.spreadNote ? ` (${d.spreadNote})` : ""}`
          : `2s10s not computable — ${d.spreadNote}.`,
        d.real.length
          ? `Inflation-linked, kept separate (a real yield is not comparable to a nominal one): ${d.real.map((r) => `${r.tenor} ${nf(r.close, 3)}`).join(" · ")}`
          : null,
      );
    },
  },

  // ── ML track record (admin, wave 3) ──────────────────────────────────────
  "ml.track": {
    summary: "The ML Studio's prediction ledger — the only evidence of real out-of-sample skill, pending entries included.",
    visibility: "admin",
    source: "mlmemory",
    args: { limit: { type: "int", default: 10, min: 1, max: 50 } },
    select(raw, a) {
      const preds = raw?.preds || [];
      const runs = raw?.runs || [];
      const forecasts = preds.filter((p) => p.type === "forecast");
      const resolved = forecasts.filter((p) => p.resolved);
      const rankings = preds.filter((p) => p.type === "ranking" && p.resolved);
      return {
        runs: runs.length,
        forecastN: resolved.length,
        forecastHitRate: resolved.length ? resolved.filter((p) => p.hit).length / resolved.length : null,
        rankingN: rankings.length,
        rankingAvgSpread: rankings.length ? rankings.reduce((s, p) => s + (p.spread || 0), 0) / rankings.length : null,
        pending: preds.filter((p) => !p.resolved).length,
        latest: preds.slice(0, a.limit).map((p) => ({
          type: p.type, symbol: p.symbol || null, model: p.model || null, month: p.month || null,
          madeAt: toMs(p.madeAt), resolved: !!p.resolved,
          predRet: p.predRet ?? null, actualRet: p.actualRet ?? null, hit: p.hit ?? null,
          spread: p.spread ?? null,
        })),
      };
    },
    digest(d, { now } = {}) {
      if (!d.forecastN && !d.pending && !d.runs) return "The ML ledger is empty.";
      return block(
        `${d.runs} runs logged · ${d.pending} predictions still open`,
        // A hit rate under ~30 resolved forecasts is not evidence, and saying so
        // costs one line — the same discipline the meta-label gate enforces.
        d.forecastN
          ? `Forecasts: ${d.forecastN} resolved, ${pct(d.forecastHitRate, 0)} directional hits${d.forecastN < 30 ? " — too few to mean anything yet" : ""}`
          : "No forecast has resolved yet.",
        d.rankingN ? `Rankings: ${d.rankingN} resolved, average spread vs benchmark ${nf(d.rankingAvgSpread * 100, 2)}%` : null,
        d.latest.length
          ? table(["type", "symbol", "made", "pred", "actual", "hit"],
              d.latest.map((p) => [
                p.type, p.symbol || p.month || "—", ago(p.madeAt, now),
                p.predRet != null ? `${nf(p.predRet * 100, 2)}%` : "—",
                p.actualRet != null ? `${nf(p.actualRet * 100, 2)}%` : "—",
                p.resolved ? (p.hit ? "yes" : "no") : "open",
              ]))
          : null,
      );
    },
  },
};

// ── catalog helpers ─────────────────────────────────────────────────────────

export const RESOURCE_IDS = Object.keys(RESOURCES);

/** Everything a caller may see, with its arguments — also the future chat's tool list. */
export function listResources({ visibility = "public" } = {}) {
  return RESOURCE_IDS
    .filter((id) => visibility === "admin" || RESOURCES[id].visibility === "public")
    .map((id) => ({
      id,
      summary: RESOURCES[id].summary,
      visibility: RESOURCES[id].visibility,
      source: RESOURCES[id].source,
      args: describeArgs(RESOURCES[id].args),
    }));
}

export function getResource(id) {
  return Object.hasOwn(RESOURCES, id) ? RESOURCES[id] : null;
}

/**
 * Validate one call's arguments without touching a source. The endpoint needs
 * the coerced values to build its request (a symbol, an interval) BEFORE it can
 * fetch anything, and it must not do that coercion itself — the schema is the
 * catalog's, and a second implementation of it is exactly how an allowlist rots.
 */
export function argsFor(id, rawArgs) {
  const res = getResource(id);
  if (!res) throw new ArgError("unknown_resource", id);
  return coerceArgs(res.args, rawArgs);
}

/**
 * Run one resource against already-fetched source bytes. Pure — the fetching is
 * the endpoint's job, which is what makes every resource testable offline
 * against a real recorded snapshot.
 * @returns {{ resource, ok, asOf, stale, data, digest }}
 */
export function resolve(id, rawArgs, raw, { now = Date.now() } = {}) {
  const res = getResource(id);
  if (!res) return { resource: id, ok: false, error: "unknown_resource" };
  const args = coerceArgs(res.args, rawArgs);
  const src = SOURCES[res.source];
  const asOf = src.asOf ? src.asOf(raw) : 0;
  const data = res.select(raw, args, { now });
  return {
    resource: id,
    ok: true,
    args,
    source: res.source,
    asOf,
    // Staleness is reported, never hidden. A layer that returns yesterday's
    // number as if it were now is worse than one that returns nothing.
    stale: asOf > 0 ? now - asOf > src.staleAfterMs : true,
    staleAfterMs: src.staleAfterMs,
    data,
    digest: res.digest(data, { now }),
  };
}
