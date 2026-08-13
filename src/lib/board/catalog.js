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
import { PANELS, panelEntries } from "../universe.js";
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
      const head = `${d.total} lessons · ${c.losing || 0} losing, ${c.winning || 0} winning, ${c.neutral || 0} neutral` +
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
      tier: { type: "int", default: null, min: 1, max: 2, note: "1 = official/wire, 2 = mainstream desks" },
      q: { type: "string", default: null, max: 60, note: "case-insensitive substring of title or description" },
      window: { type: "duration", default: "24h" },
      limit: { type: "int", default: 20, min: 1, max: 100 },
    },
    select(raw, a, { now = Date.now() } = {}) {
      let items = raw?.items || [];
      if (a.category) items = items.filter((i) => i.category === a.category);
      if (a.tier) items = items.filter((i) => i.tier === a.tier);
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
