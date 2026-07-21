// research-agent.mjs — the autonomous research loop (Cortex phase 4).
// Scheduled 2–5× per night (see docs/LAB_AGENT_TUTORIAL.md). Each run:
//
//   1. HARVEST: pull material from 7 free sources — arXiv, OpenAlex, Crossref,
//      Zenodo, practitioner blogs (RSS), Hacker News, and YouTube transcripts
//      via yt-dlp (scripts/sources.mjs)
//   2. READ: upgrade abstract → FULL TEXT where available (arXiv HTML, RSS
//      content:encoded, auto-captions). An abstract says an effect exists; the
//      body says how it was measured. This is the biggest quality lever here.
//   3. EXTRACT: ask the site's own AI codegen (/api/generate — key stays
//      server-side) to turn the text into a testable strategy(ctx)
//   4. VALIDATE: compile → backtest on two markets → k-fold consistency →
//      price-noise robustness → Deflated Sharpe with a GLOBAL trial counter
//      (every strategy ever generated raises the bar — honest data-mining
//      accounting, López de Prado style)
//   5. JUDGE against BOTH profiles (prop / private). One backtest, two verdicts:
//      the same strategy can be private-grade but breach a prop drawdown rule.
//   6. STORE: survivors → lab:candidates tagged with the profiles they cleared;
//      failures → local graveyard with the reason. Summary → lab:state.research
//
// The LLM proposes; the math disposes. All virtual, not investment advice.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runBacktest, compileStrategy } from "../src/lib/backtest.js";
import { kFoldCode, noiseTest, deflatedSharpe, equityReturns } from "../src/lib/validation.js";
import { qualifyAll, getProfile, PROFILE_IDS } from "../src/lib/profiles.js";
import { harvestAll, fullTextOf, topicsOf, RELEVANCE } from "./sources.mjs";
import { loadUniverse } from "./marketdata.mjs";
import { UNIVERSE, byId, costFor, effectiveTrials, describeMarkets } from "../src/lib/markets.js";
import { initPy, compilePyStrategy, pyCompileCheck } from "./pyRunnerNode.mjs";

// Language Cortex writes AND validates in. Python (default) means the model emits
// a vectorised `signals(df)`, and the ENTIRE gauntlet below runs that Python
// through Pyodide — so the code that gets promoted, paper-traded and shown as
// copyable is the exact artifact the math validated. Set LAB_RESEARCH_LANG=js to
// fall back to the classic strategy(ctx) path.
const RESEARCH_LANG = String(process.env.LAB_RESEARCH_LANG || "python").toLowerCase() === "js" ? "js" : "python";

// Compile a strategy to a signalFn regardless of language: Python goes through
// Pyodide (vectorised signals(df), memoised per candle array — a drop-in for the
// JS compiler), JS through the classic per-bar compiler. Every backtest, k-fold,
// noise and delay probe below funnels through here, so the gauntlet itself never
// has to know which language it's judging.
function compileFor(code, lang) {
  return lang === "python" ? compilePyStrategy(code) : compileStrategy(code);
}
// Throwing compile+run check — the language-aware twin of `try { compileStrategy }`.
function compileCheckFor(code, lang) {
  if (lang === "python") return pyCompileCheck(code);
  compileStrategy(code);
  return true;
}

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
const RESEARCH_FILE = join(homedir(), ".mmmxcix-research.json");
const MAX_PAPERS_PER_RUN = +(process.env.LAB_RESEARCH_PAPERS || 2); // gentle on the free AI tier
// Costs are per market now (src/lib/markets.js costFor): a 15-minute equity
// strategy pays far more spread than a daily one, and the old flat 10bps was
// flattering exactly the high-frequency candidates most likely to be noise.
// Auto-promotion thresholds and caps now live per profile in src/lib/profiles.js
// (prop: DSR ≥ 97, cap 3 · private: DSR ≥ 95, cap 8). The math earns the
// promotion; no human click needed.
// "Until-hit" mode: keep reading papers until ONE clears the gauntlet, then
// stop early. Bounded by HARD_CAP so a barren night can't run forever or drain
// the LLM quota. NOTE: every attempt raises the global Deflated-Sharpe bar
// (anti-overfitting), so forcing more reads makes each pass harder — the cap is
// the honest brake. Opt in with LAB_RESEARCH_UNTIL_HIT=1.
const UNTIL_HIT = process.env.LAB_RESEARCH_UNTIL_HIT === "1";
const HARD_CAP = +(process.env.LAB_RESEARCH_MAX || 12);

if (!TOKEN) { console.error("LAB_TOKEN is not set."); process.exit(1); }

// ── local research memory ───────────────────────────────────────────────────
function load() {
  try { return JSON.parse(readFileSync(RESEARCH_FILE, "utf8")); } catch {
    return { seen: [], attempts: 0, graveyard: [], candidates: [], papersRead: 0 };
  }
}
function save(st) { writeFileSync(RESEARCH_FILE, JSON.stringify(st)); }

// How many strategies were tried in the recent SELECTION WINDOW — the pool this
// candidate was actually chosen from.
//
// The old code passed the lifetime attempt count into the Deflated Sharpe
// hurdle. That sounds conservative and is in fact self-defeating: the counter
// only ever grows, so the bar rises forever and the agent eventually cannot
// promote anything no matter how good it is. Measured: a Sharpe-1.05 strategy
// scores DSR 74% at 30 trials but 43% at 300 — with a 97% bar the system
// strangles itself after a few dozen papers.
//
// A rolling window is the honest correction: strategies tried months ago on
// unrelated papers were not part of the selection that produced this one.
const TRIAL_WINDOW_DAYS = +(process.env.LAB_TRIAL_WINDOW_DAYS || 30);
// Ceiling on the windowed count. Past a few hundred trials the Deflated Sharpe
// curve flattens out and every additional trial buys almost no information
// while still pushing the bar down — capping keeps the hurdle meaningful
// instead of asymptotically impossible.
const TRIAL_WINDOW_CAP = +(process.env.LAB_TRIAL_WINDOW_CAP || 60);
function windowTrials(st) {
  const cutoff = Date.now() - TRIAL_WINDOW_DAYS * 864e5;
  const recent = (st.attemptLog || []).filter((t) => t >= cutoff).length;
  // Before the log existed, fall back to the lifetime count so an existing
  // install does not suddenly get an artificially easy hurdle.
  const n = recent || (st.attempts || 1);
  return Math.max(1, Math.min(n, TRIAL_WINDOW_CAP));
}

// Harvesting, topic tagging and full-text extraction all live in sources.mjs
// now — this file is about judgement, not plumbing.

// ── brain vault: build the knowledge graph the site renders ─────────────────
function brainSources(st) {
  const counts = {};
  for (const x of [...(st.candidates || []), ...(st.graveyard || [])]) {
    const s = x.source || "?";
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}
function buildBrain(st) {
  const CAP = 120;
  // Backfill topics from the title for legacy entries saved before tagging, so
  // the graph links up immediately instead of waiting for the store to churn.
  const cNodes = (st.candidates || []).slice(0, 30).map((c) => ({
    id: c.id, label: (c.name || "").slice(0, 52), outcome: "candidate",
    source: c.source || "?", topics: (c.topics && c.topics.length) ? c.topics : topicsOf(c.name || ""), dsr: c.dsr,
  }));
  const gNodes = (st.graveyard || []).slice(0, CAP - cNodes.length).map((g, i) => ({
    id: `g_${i}`, label: (g.title || "").slice(0, 52), outcome: "graveyard",
    source: g.source || "?", topics: (g.topics && g.topics.length) ? g.topics : topicsOf(g.title || ""), reason: g.reason,
  }));
  const nodes = [...cNodes, ...gNodes];
  // edges: nodes sharing ≥1 topic, capped per node so the graph stays legible
  const edges = [];
  const deg = {};
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = (nodes[i].topics || []).find((t) => (nodes[j].topics || []).includes(t));
      if (shared && (deg[i] || 0) < 4 && (deg[j] || 0) < 4) {
        edges.push({ a: i, b: j, topic: shared });
        deg[i] = (deg[i] || 0) + 1; deg[j] = (deg[j] || 0) + 1;
      }
    }
  }
  return { nodes, edges, sources: brainSources(st), stats: { papersRead: st.papersRead || 0, candidates: (st.candidates || []).length, graveyard: (st.graveyard || []).length } };
}

// ── 2. abstract → strategy code via the site's own AI endpoint ─────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate limits are infrastructure noise, not strategy failures: retry with
// backoff, and signal "SKIP" (don't bury, don't mark seen) if still limited.
async function generateStrategy(item) {
  // Full text where we could get it, abstract otherwise. `research` is a
  // separate endpoint channel because a document does not fit the 2000-char
  // prompt cap — truncating it there would undo the whole point of reading it.
  const text = (item.fullText && item.fullText.length > item.abstract.length)
    ? item.fullText
    : item.abstract;
  const payload = {
    token: TOKEN,
    language: RESEARCH_LANG,
    research: { title: item.title.slice(0, 200), kind: item.kind || "document", text },
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${SITE}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.code) return { code: out.code, language: out.language || RESEARCH_LANG };
    if (res.status === 429 || out.error === "rate_limited") {
      if (attempt < 3) { console.log(`  rate-limited, retry ${attempt}/2 in ${attempt * 45}s…`); await sleep(attempt * 45000); continue; }
      const e = new Error("rate_limited"); e.skip = true; throw e;
    }
    throw new Error(out.error || `generate HTTP ${res.status}`);
  }
}

// Self-repair: when generated code won't even compile, send it back once with
// the error and ask the model to fix the signature/format. One extra call, only
// on failure — cheap insurance against a model that ignored the naming contract.
async function repairStrategy(code, error, language = RESEARCH_LANG) {
  const res = await fetch(`${SITE}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, language, repair: { code: String(code).slice(0, 8000), error: String(error).slice(0, 300) } }),
  });
  const out = await res.json().catch(() => ({}));
  if (res.ok && out.code) return out.code;
  const e = new Error(out.error || `repair HTTP ${res.status}`);
  if (res.status === 429 || out.error === "rate_limited") e.skip = true;
  throw e;
}

// ── 3. validation gauntlet (candle fetchers live in marketdata.mjs) ─────────

/**
 * Out-of-sample holdout: re-run on the most recent 30% alone.
 *
 * With hardcoded parameters there is nothing to "train", so walk-forward
 * optimisation does not apply. What DOES apply is regime stability — a rule
 * fitted (by the model, from the paper) to the era that dominates the series
 * will fall apart on the recent tail. This catches that.
 */
function holdout(code, candles, feeBps, lang) {
  const cut = Math.floor(candles.length * 0.7);
  const tail = candles.slice(cut);
  if (tail.length < 150) return { ok: true, skipped: "too short" };
  try {
    const res = runBacktest({ candles: tail, signalFn: compileFor(code, lang), initialCapital: 10000, feeBps });
    if (res.warnings.length) return { ok: false, detail: "error on holdout" };
    const m = res.metrics;
    if (m.tradeCount < 5) return { ok: true, skipped: "few trades" };
    // Not demanding profit — demanding it did not invert. A strategy that made
    // money overall but bleeds on the recent third is a regime artefact.
    if (m.profitFactor < 0.9) return { ok: false, detail: `holdout PF ${m.profitFactor.toFixed(2)}` };
    return { ok: true, pf: +m.profitFactor.toFixed(2), ret: +m.totalReturnPct.toFixed(1) };
  } catch {
    return { ok: false, detail: "holdout threw" };
  }
}

/**
 * Run the gauntlet across the WHOLE market universe and report where the
 * strategy actually works.
 *
 * The old version demanded success on BTC 4h AND SPY 1d, which buried anything
 * specialised — a rule that is excellent on 15-minute AAPL and useless on
 * Bitcoin was recorded as a failure. It is not a failure; it is a strategy with
 * a domain. So each market is judged on its own and the result is TAGGED.
 *
 * The obvious hazard is cherry-picking: test ten venues, keep the luckiest.
 * That is handled honestly rather than ignored — the Deflated Sharpe trial
 * count is multiplied by the number of markets tested (effectiveTrials), so
 * searching wider genuinely makes each claim harder to sustain.
 *
 * Costs are per market: 15-minute equity pays far more spread than daily, and
 * a flat 10bps everywhere was flattering exactly the strategies most likely to
 * be noise.
 */

// The committee's bear case. Runs ONLY on a strategy that already survived the
// gauntlet, so it is rare and cheap — a handful of calls a month. The gauntlet
// is the mathematical adversary; this is the qualitative one, and it is what
// the AI-committee design (the source doc) calls the debate + invalidation
// conditions + confidence score. Failure is non-fatal: a survivor without a
// written verdict is still a survivor.
async function committeeReview(code, cand) {
  const facts = Object.entries(cand.byMarket || {})
    .filter(([, v]) => v && (v.profiles || []).length)
    .map(([mid, v]) => `${mid}: ret ${v.ret}% PF ${v.pf} dd ${v.dd}% n=${v.n} DSR ${v.dsr}%`)
    .join("; ");
  try {
    const res = await fetch(`${SITE}/api/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, critique: { code, title: cand.name, facts } }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.critique) return out.critique;
  } catch (e) {
    console.error(`  committee review failed: ${e.message.slice(0, 50)}`);
  }
  return null;
}

// Liveness: the highest trade count this strategy reaches on the core markets.
// A generation that never fires (n=0) or enters once and holds forever (n=1) is
// a degenerate no-op, not a real idea — the "no edge anywhere (n=0)" lines in
// the log. Probing a few markets is milliseconds, so it is cheap to catch these
// BEFORE they consume a gauntlet trial and clutter the graveyard.
function livenessTrades(code, datasets, lang) {
  let max = 0;
  for (const { market, candles } of datasets.slice(0, 3)) {
    try {
      const res = runBacktest({ candles, signalFn: compileFor(code, lang), initialCapital: 10000, feeBps: costFor(market) });
      if (!res.warnings.length) max = Math.max(max, res.metrics.tradeCount);
    } catch { /* runtime error → the gauntlet reports it properly */ }
  }
  return max;
}

// Sharpe when the strategy's ENTIRE decision is delayed by one bar — the
// execution-robustness probe. A genuine edge barely changes; a timing artifact
// that only works with perfect fills collapses. Returns 0 on any failure.
function delayedSharpe(code, candles, feeBps, lang) {
  try {
    const inner = compileFor(code, lang);
    let prev = "flat";
    const fn = (ctx) => { const s = inner(ctx); const out = prev; prev = s; return out; };
    const res = runBacktest({ candles, signalFn: fn, initialCapital: 10000, feeBps });
    if (res.warnings.length) return 0;
    return res.metrics.sharpe ?? 0;
  } catch { return 0; }
}

// Pull the EDGE / WORKS / BREAKS header the generation prompt asks for, so a
// candidate carries its own thesis. Missing lines just come back empty. A regex
// LITERAL (not new RegExp with a template string) — the latter's \\s collapses
// to a literal s and silently never matches.
function parseThesis(code) {
  const out = { edge: "", works: "", breaks: "" };
  // Accept both comment styles so it works for JS (// EDGE:) and Python (# EDGE:).
  const re = /(?:\/\/|#)\s*(EDGE|WORKS|BREAKS)\s*:\s*(.+)/gi;
  let m;
  while ((m = re.exec(code))) {
    const key = m[1].toLowerCase();
    if (key in out) out[key] = m[2].trim().slice(0, 240);
  }
  return out;
}

function gauntlet(code, datasets, globalTrials, lang) {
  try { compileCheckFor(code, lang); } catch (e) { return { pass: false, reason: `compile: ${e.message.slice(0, 80)}` }; }

  // Pass 1 — cheap: run every market, keep the ones that made money at all.
  const ran = [];
  for (const { name, market, candles } of datasets) {
    const feeBps = costFor(market);
    let res;
    try {
      res = runBacktest({ candles, signalFn: compileFor(code, lang), initialCapital: 10000, feeBps });
    } catch (e) {
      return { pass: false, reason: `runtime(${name}): ${e.message.slice(0, 55)}` };
    }
    // A strategy error is fatal everywhere, not just here — bail immediately.
    if (res.warnings.length) return { pass: false, reason: `strategy error (${name}): ${res.warnings[0].slice(0, 70)}` };
    ran.push({ name, market, candles, feeBps, m: res.metrics, equity: res.equity });
  }

  const promising = ran.filter((r) => r.m.tradeCount >= 20 && r.m.totalReturnPct > 0 && r.m.profitFactor > 1.05);
  if (!promising.length) {
    const best = ran.slice().sort((a, b) => b.m.profitFactor - a.m.profitFactor)[0];
    return {
      pass: false,
      reason: best
        ? `no edge anywhere (best ${best.name}: ret ${best.m.totalReturnPct.toFixed(0)}%, PF ${best.m.profitFactor.toFixed(2)}, n=${best.m.tradeCount})`
        : "no markets ran",
      byMarket: summarise(ran),
    };
  }

  // The honest hurdle. globalTrials is a WINDOWED count (see windowTrials
  // below), and markets are counted as correlated clusters rather than
  // individually — SPY and QQQ are not two independent bets.
  const trials = effectiveTrials(globalTrials, datasets.map((d) => d.market.asset));

  // Pass 2 — expensive robustness, only on the promising venues.
  const byMarket = {};
  const qualifiedProfiles = new Set();
  const winningMarkets = [];
  const rejections = [];

  for (const r of promising) {
    const mk = { ...metricRow(r.m) };

    // BUY & HOLD BENCHMARK — the honest bar that was missing. A strategy with a
    // real statistical edge (passes DSR/k-fold/noise) can STILL be worse than
    // simply holding the asset through a bull market, because it trades less
    // than 100% exposure and pays fees. Sharpe is the exposure-fair comparison:
    // if the strategy doesn't beat holding risk-adjusted, it does not belong in
    // the paper book for that market — no matter how "real" its edge is.
    const bhS = r.m.buyHoldSharpe ?? 0, sh = r.m.sharpe ?? 0;
    if (sh <= bhS) {
      byMarket[r.name] = { ...mk, rejected: `Sharpe ${sh.toFixed(2)} ≤ buy&hold ${bhS.toFixed(2)}` };
      rejections.push(`${r.name}: loses to buy & hold (Sharpe ${sh.toFixed(2)} ≤ ${bhS.toFixed(2)})`);
      continue;
    }

    // EXECUTION-TIMING ROBUSTNESS — the edge must not depend on catching a move
    // within one bar. Re-run with the whole decision delayed by ONE bar; if the
    // Sharpe collapses, the backtest overstated real performance and the strategy
    // will go negative on a broker's actual fills. This is the test that was
    // missing — DSR/k-fold/noise all use the same favourable fill timing, so they
    // passed timing-fragile strategies. It caught ICT on BTC: +3086% → -43%.
    const delSharpe = delayedSharpe(code, r.candles, r.feeBps, lang);
    if (delSharpe < Math.max(0.1, sh * 0.5)) {
      byMarket[r.name] = { ...mk, rejected: `timing-fragile (Sharpe ${sh.toFixed(2)}→${delSharpe.toFixed(2)} on 1-bar delay)` };
      rejections.push(`${r.name}: timing-fragile (collapses on 1-bar execution delay)`);
      continue;
    }

    const kf = kFoldCode({ candles: r.candles, makeSignalFn: () => compileFor(code, lang), feeBps: r.feeBps });
    if (!kf || kf.verdict !== "pass") {
      byMarket[r.name] = { ...mk, rejected: `k-fold ${kf ? kf.profitableFolds + "/" + kf.totalFolds : "n/a"}` };
      rejections.push(`${r.name}: k-fold`);
      continue;
    }
    const nz = noiseTest({ candles: r.candles, makeSignalFn: () => compileFor(code, lang), runs: 15, feeBps: r.feeBps });
    if (!nz || nz.verdict !== "pass") {
      byMarket[r.name] = { ...mk, rejected: `noise ${nz ? nz.medianReturnPct.toFixed(0) + "%" : "n/a"}` };
      rejections.push(`${r.name}: noise`);
      continue;
    }
    const ho = holdout(code, r.candles, r.feeBps, lang);
    if (!ho.ok) {
      byMarket[r.name] = { ...mk, rejected: ho.detail };
      rejections.push(`${r.name}: ${ho.detail}`);
      continue;
    }

    const dsrRaw = deflatedSharpe(equityReturns(r.equity), trials);
    const dsrPct = dsrRaw ? dsrRaw.dsr * 100 : 0;

    const { qualified, reasons } = qualifyAll({ perSet: [{ name: r.name, m: r.m }], dsrPct });
    byMarket[r.name] = {
      ...mk, dsr: +dsrPct.toFixed(1), holdoutPf: ho.pf ?? null,
      profiles: qualified,
      ...(qualified.length ? {} : { rejected: reasons.private || reasons.prop }),
    };
    if (qualified.length) {
      winningMarkets.push(r.name);
      for (const p of qualified) qualifiedProfiles.add(p);
    } else {
      rejections.push(`${r.name}: ${reasons.private || reasons.prop}`);
    }
  }

  // Fill in the markets that never reached pass 2, so the record is complete.
  for (const r of ran) if (!byMarket[r.name]) byMarket[r.name] = { ...metricRow(r.m), rejected: "no edge" };

  if (!winningMarkets.length) {
    return { pass: false, reason: rejections[0] || "failed robustness everywhere", byMarket, trials };
  }

  // Report the strongest venue as the headline.
  const best = winningMarkets
    .slice()
    .sort((a, b) => (byMarket[b].dsr ?? 0) - (byMarket[a].dsr ?? 0))[0];

  return {
    pass: true,
    byMarket,
    markets: winningMarkets,
    bestMarket: best,
    dsr: byMarket[best].dsr,
    qualified: [...qualifiedProfiles],
    trials,
    marketsTested: datasets.length,
  };
}

/** Which profiles a single market qualified for. */
const byMarket_profiles = (verdict, mid) => verdict.byMarket?.[mid]?.profiles;

const metricRow = (m) => ({
  ret: +m.totalReturnPct.toFixed(1), pf: +m.profitFactor.toFixed(2),
  dd: +m.maxDrawdownPct.toFixed(1), n: m.tradeCount,
  sharpe: +(m.sharpe ?? 0).toFixed(2), win: +(m.winRatePct ?? 0).toFixed(0),
  bhRet: +(m.buyHoldReturnPct ?? 0).toFixed(1), bhSharpe: +(m.buyHoldSharpe ?? 0).toFixed(2),
});
const summarise = (ran) => Object.fromEntries(ran.map((r) => [r.name, metricRow(r.m)]));

// ── main ────────────────────────────────────────────────────────────────────
const st = load();
// In until-hit mode pull a deeper pool per source so there's enough supply.
const { items: harvested, counts: sourceCounts } = await harvestAll({ perSource: UNTIL_HIT ? 20 : 10 });
const limit = UNTIL_HIT ? HARD_CAP : MAX_PAPERS_PER_RUN;

// Two gates before anything costs an LLM call:
//   topical  — the item is about trading at all (topics + RELEVANCE)
//   readable — there is enough text to extract a rule from. Crossref and
//              OpenAlex regularly return records with an EMPTY abstract; those
//              used to reach the model as a bare title and produce invented
//              strategies. A title is not a source.
const MIN_TEXT = 220;
const fresh = harvested
  .filter((p) => !st.seen.includes(p.id))
  .filter((p) => (p.topics?.length > 0) && RELEVANCE.test(`${p.title} ${p.abstract}`))
  .filter((p) => (p.abstract || "").length >= MIN_TEXT || p.kind === "video")
  .slice(0, limit);
console.log(
  `harvest: ${harvested.length} unique, ${fresh.length} fresh+readable this run` +
  `${UNTIL_HIT ? ` (until-hit, cap ${HARD_CAP})` : ""}`
);

// Upgrade abstract → full text for exactly the items we will actually spend a
// model call on. Doing this after the filter keeps the network cost bounded:
// no point pulling a 14k-char transcript for something we then skip.
for (const item of fresh) {
  item.fullText = await fullTextOf(item);
  if (item.fullText) {
    // Re-tag on the richer text — a body often reveals topics the abstract hid.
    item.topics = [...new Set([...(item.topics || []), ...topicsOf(item.fullText)])];
    console.log(`  ↳ full text ${item.fullText.length} chars — ${item.title.slice(0, 44)}`);
  }
}

// The full universe: crypto, equity index, single names, forex, across
// timeframes from 15m to daily. A strategy only has to work SOMEWHERE.
const datasets = fresh.length ? await loadUniverse(UNIVERSE) : [];

// Boot the Python runtime once, up front, if Cortex is writing Python and there
// is work to do — the whole gauntlet then runs signals(df) synchronously through
// this one Pyodide instance (numpy + pandas). ~3s, amortised over every backtest.
if (RESEARCH_LANG === "python" && fresh.length) {
  const t = Date.now();
  await initPy((m) => console.log(`  ${m}`));
  console.log(`Python runtime ready in ${((Date.now() - t) / 1000).toFixed(1)}s — Cortex will write & validate in Python`);
}

const newCandidates = [];
const toPromote = [];
let firstPaper = true;
let processed = 0; // papers actually evaluated this run (may stop early on a hit)
for (const paper of fresh) {
  if (!firstPaper) await sleep(20000); // stay under the free tier's per-minute cap
  firstPaper = false;
  processed++;
  try {
    let { code, language } = await generateStrategy(paper);
    // Self-repair probe: if it won't compile/run, ask the model to fix it once.
    // For Python this runs the code through Pyodide on a synthetic series.
    try {
      compileCheckFor(code, language);
    } catch (ce) {
      console.log(`  ⚠ won't compile (${ce.message.slice(0, 45)}) — repair attempt…`);
      try {
        const fixed = await repairStrategy(code, ce.message, language);
        compileCheckFor(fixed, language); // throws if still broken → keep original, gauntlet buries it
        code = fixed;
        console.log("  ✓ repaired");
      } catch (re) {
        if (re.skip) throw re; // rate-limited repair → treat as infra skip, paper stays fresh
        console.log(`  ✗ repair failed (${String(re.message || "").slice(0, 40)})`);
      }
    }
    // Liveness repair: if the strategy barely trades, it is a degenerate
    // generation (a condition that never triggers), not a real idea. Give the
    // model ONE chance to make it actually fire — same self-repair pattern as
    // the compile fix, aimed squarely at the n=0/n=1 no-ops. Only keep the
    // rewrite if it genuinely trades more, so a failed repair can't make it worse.
    if (datasets.length) {
      const live = livenessTrades(code, datasets, language);
      if (live < 5) {
        console.log(`  ⚠ near-zero trades (max ${live}) — liveness repair…`);
        try {
          const fixed = await repairStrategy(code,
            `This strategy makes only ${live} trades over thousands of bars — its entry/exit conditions almost never trigger. ` +
            "Rewrite so it actually enters AND exits regularly on normal price data. Prefer conditions relative to recent " +
            "price/indicator values (crossovers, bands, percentiles) over rare absolute thresholds, and make sure the exit " +
            "condition can realistically occur. Keep the same core idea.", language);
          compileCheckFor(fixed, language);
          if (livenessTrades(fixed, datasets, language) > live) { code = fixed; console.log("  ✓ liveness repaired"); }
          else console.log("  ✗ liveness repair no better — keeping original (gauntlet will bury it)");
        } catch (re) {
          if (re.skip) throw re; // rate-limited → infra skip, paper stays fresh
          console.log(`  ✗ liveness repair failed (${String(re.message || "").slice(0, 40)})`);
        }
      }
    }

    st.seen = [...st.seen, paper.id].slice(-500); // only consumed once generation succeeded
    st.papersRead++;
    st.attempts++;                                   // lifetime counter, for the record
    st.attemptLog = [...(st.attemptLog || []), Date.now()].slice(-5000);
    const verdict = gauntlet(code, datasets, windowTrials(st), language);
    if (verdict.pass) {
      const cand = {
        id: `rc_${Date.now().toString(36)}`,
        name: paper.title.slice(0, 70),
        paper: paper.link,
        source: paper.source,
        kind: paper.kind,
        readFullText: !!paper.fullText,
        topics: paper.topics,
        code,
        // The language the strategy is written in AND was validated in (python |
        // js). Carried onto the candidate + every promotion so the paper agent
        // compiles it the same way and the UI shows/copies the right source.
        language,
        // The framework's "why does this have an edge" — parsed from the
        // EDGE/WORKS/BREAKS header the generation prompt now emits, so every
        // survivor is self-documenting (edge thesis, the regime it needs, and
        // what kills it) instead of being an opaque block of code.
        thesis: parseThesis(code),
        // Where it works, not just how well. byMarket carries every venue that
        // was tried, including the rejections and why — the graveyard for a
        // strategy that ALMOST worked is the most useful thing in the record.
        byMarket: verdict.byMarket,
        markets: verdict.markets,
        bestMarket: verdict.bestMarket,
        marketsTested: verdict.marketsTested,
        trialsUsed: verdict.trials,
        dsr: verdict.dsr,
        // Which regimes this cleared. A strategy can be private-grade and still
        // breach a prop drawdown rule — that is information, not a failure.
        profiles: verdict.qualified,
        trialsAtPass: st.attempts,
        foundAt: Date.now(),
      };
      console.log(
        `✓ CANDIDATE: ${cand.name} (DSR ${cand.dsr}% on ${cand.bestMarket}) ` +
        `→ works on ${verdict.markets.join(", ")} · profiles: ${verdict.qualified.join(", ")}`
      );

      // Committee bear case — the qualitative half of the debate. Only survivors
      // reach here, so this is a rare, cheap call. Attaching a written thesis,
      // confidence, and invalidation conditions is what turns a passing backtest
      // into a decision a human can actually stand behind.
      cand.committee = await committeeReview(code, cand);
      if (cand.committee) {
        console.log(`  ⚖ committee: confidence ${cand.committee.confidence ?? "?"}% · regime ${cand.committee.regime || "?"}`);
        if (cand.committee.bear) console.log(`     bear: ${cand.committee.bear.slice(0, 90)}`);
      }

      st.candidates = [cand, ...st.candidates].slice(0, 30);
      newCandidates.push(cand);

      // Auto-promote per profile AND per winning market: a strategy that works
      // on both EUR/USD daily and SOL 15m is two paper positions, not one, and
      // collapsing them to a single BTC line would have been a lie about what
      // was actually validated.
      for (const pid of verdict.qualified) {
        const prof = getProfile(pid);
        if (cand.dsr < prof.promotion.minDsr) continue;
        for (const mid of verdict.markets) {
          if (!(byMarket_profiles(verdict, mid) || []).includes(pid)) continue;
          const m = byId(mid);
          if (!m) continue;
          toPromote.push({
            id: `${cand.id}_${pid}_${mid}`, name: `🤖 ${cand.name} · ${m.label}`,
            mode: "code", code: cand.code, language: cand.language,
            market: m.asset === "crypto" ? "crypto" : "stock",
            symbol: m.symbol, interval: m.interval,
            feeBps: costFor(m), positionPct: 100,
            volTarget: true, // GARCH vol-targeted sizing — cuts drawdown by default
            dsr: verdict.byMarket[mid]?.dsr ?? cand.dsr, paper: cand.paper,
            profile: pid, candidateId: cand.id, marketId: mid,
          });
          console.log(`  🤖 auto-promote queued: ${prof.label} · ${m.label}`);
        }
      }
      if (UNTIL_HIT) { console.log(`  ↳ hit after ${processed} paper(s) — stopping early (until-hit mode)`); break; }
    } else {
      st.graveyard = [{ title: paper.title.slice(0, 70), reason: verdict.reason, source: paper.source, topics: paper.topics, at: Date.now() }, ...st.graveyard].slice(0, 200);
      console.log(`✗ graveyard: ${paper.title.slice(0, 50)} — ${verdict.reason}`);
    }
  } catch (e) {
    if (e.skip) {
      console.log(`~ skipped (infra: ${e.message}) — paper stays fresh for the next run`);
    } else {
      st.seen = [...st.seen, paper.id].slice(-500);
      st.graveyard = [{ title: paper.title.slice(0, 70), reason: `gen: ${e.message.slice(0, 60)}`, source: paper.source, topics: paper.topics, at: Date.now() }, ...st.graveyard].slice(0, 200);
      console.log(`✗ generation failed: ${e.message}`);
    }
  }
}
save(st);

// Read the current lab state ONCE — used both to gate promotion on portfolio
// health (RiskGate) and to preserve paper state when we merge our summary in.
const cur = await (await fetch(`${SITE}/api/lab`, { headers: { "x-lab-token": TOKEN } })).json().catch(() => ({}));

// candidates always accumulate on the site
if (newCandidates.length) {
  const r = await fetch(`${SITE}/api/lab`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, candidates: newCandidates }),
  });
  console.log(`candidates pushed: ${(await r.json().catch(() => ({}))).stored ?? "?"} stored on site`);
}

// Auto-promotion — gated by RiskGate PER PROFILE: a full prop book must not
// block a private promotion, and vice versa. Portfolio health comes from the
// paper agent's last report, which now reports one block per profile.
const holdFor = (pid) => {
  const rg = cur?.state?.riskgate?.byProfile?.[pid] || (pid === "private" ? cur?.state?.riskgate : null);
  if (!rg) return "";
  const prof = getProfile(pid);
  const openN = rg.activeLimits?.openPositions ?? 0;
  const maxN = rg.rules?.maxSimultaneousPositions ?? prof.risk.maxSimultaneousPositions;
  const dd = rg.activeLimits?.combinedDrawdownPct ?? 0;
  const maxDd = rg.rules?.maxCombinedDrawdownPct ?? prof.risk.maxCombinedDrawdownPct;
  if (openN >= maxN) return `book full (${openN}/${maxN})`;
  if (dd > maxDd) return `drawdown ${dd}% > ${maxDd}%`;
  return "";
};

const allowed = [];
const heldNotes = [];
for (const p of toPromote) {
  const hold = holdFor(p.profile);
  if (hold) heldNotes.push(`${p.profile}: ${hold}`);
  else allowed.push(p);
}
if (allowed.length) {
  const r = await fetch(`${SITE}/api/lab`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, promote: allowed }),
  });
  const o = await r.json().catch(() => ({}));
  st.autoPromoted = (st.autoPromoted || 0) + allowed.length; save(st);
  console.log(`🤖 auto-promoted ${allowed.length} → paper portfolio (active autos: ${o.autoActive ?? "?"}/${o.cap ?? "?"})`);
}
if (heldNotes.length) {
  console.log(`🚦 auto-promotion held by RiskGate — ${[...new Set(heldNotes)].join("; ")}`);
}

// brain vault: push the knowledge graph (nodes = papers, edges = shared topics)
try {
  const r = await fetch(`${SITE}/api/lab`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, brain: buildBrain(st) }),
  });
  const o = await r.json().catch(() => ({}));
  console.log(`brain pushed: ${o.nodes ?? "?"} nodes / ${o.edges ?? "?"} edges`);
} catch (e) { console.error("brain push failed:", e.message); }

// merge research stats into lab:state (read-modify-write so paper state stays)
const state = { ...(cur?.state || {}), research: {
  papersRead: st.papersRead,
  attempts: st.attempts,
  graveyard: st.graveyard.length,
  candidates: st.candidates.length,
  autoPromoted: st.autoPromoted || 0,
  sources: brainSources(st),
  // What each source actually yielded this run — makes a quietly dead feed
  // visible on the Coach page instead of only in the 3am log.
  sourceYield: sourceCounts,
  fullTextRate: fresh.length
    ? +((fresh.filter((p) => p.fullText).length / fresh.length) * 100).toFixed(0)
    : 0,
  byProfile: Object.fromEntries(
    PROFILE_IDS.map((pid) => [pid, (st.candidates || []).filter((c) => (c.profiles || []).includes(pid)).length])
  ),
  // Which venues are actually producing survivors — tells you whether the
  // universe is earning its cost or whether nine of ten markets never hit.
  marketHits: (() => {
    const hits = {};
    for (const c of st.candidates || []) for (const mid of c.markets || []) hits[mid] = (hits[mid] || 0) + 1;
    return hits;
  })(),
  universeSize: UNIVERSE.length,
  lastRun: Date.now(),
  latest: fresh.map((p) => ({ title: p.title.slice(0, 80), link: p.link, source: p.source, kind: p.kind })),
  lastGraveyard: st.graveyard.slice(0, 3).map((g) => ({ title: g.title, reason: g.reason })),
} };
const push = await fetch(`${SITE}/api/lab`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: TOKEN, state }),
});
const hitThisRun = newCandidates.length > 0;
if (UNTIL_HIT && !hitThisRun) console.log(`until-hit: no survivor in ${processed} papers (cap ${HARD_CAP} / supply exhausted) — will resume next run`);
console.log(`research run done: read ${processed}, attempts total ${st.attempts}, graveyard ${st.graveyard.length}, candidates ${st.candidates.length} → push ${(await push.json().catch(() => ({}))).ok ? "ok" : "FAILED"}`);
