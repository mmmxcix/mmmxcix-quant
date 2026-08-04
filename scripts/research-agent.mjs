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
import { auditStrategy } from "../src/lib/strategyAudit.js";
import { qualifyAll, getProfile, PROFILE_IDS } from "../src/lib/profiles.js";
import { harvestAll, fullTextOf, topicsOf, RELEVANCE, JUNK } from "./sources.mjs";
import { loadUniverse } from "./marketdata.mjs";
import { UNIVERSE, MENTIONABLE, byId, costFor, effectiveTrials, describeMarkets } from "../src/lib/markets.js";
import { initPy, compilePyStrategy, pyCompileCheck } from "./pyRunnerNode.mjs";
import { compileCppStrategy, compileQStrategy, detectTools } from "./nativeRun.mjs";
import { cleanStrategyName } from "../functions/_lib/strategyName.js";

// Which native toolchains this machine has — decides whether Cortex may write C++
// or q (it won't generate a language it can't validate here).
const NATIVE_TOOLS = detectTools();
import { mineAnomalies } from "./mining.mjs";
import { intradayTemplates } from "./intraday.mjs";
import { plateauProbe } from "./optimizer.mjs";
import { extractCode, ensureStrategyFn, parseVerdict, parseCodeReview } from "../functions/_lib/codegen.mjs";

// Language Cortex writes AND validates in. Python (default) means the model emits
// a vectorised `signals(df)`, and the ENTIRE gauntlet below runs that Python
// through Pyodide — so the code that gets promoted, paper-traded and shown as
// copyable is the exact artifact the math validated. Set LAB_RESEARCH_LANG=js to
// fall back to the classic strategy(ctx) path.
const RESEARCH_LANG = String(process.env.LAB_RESEARCH_LANG || "python").toLowerCase() === "js" ? "js" : "python";

// Cortex picks the language that FITS each idea rather than always writing Python
// (both run in the same engine and both now support stop/target brackets). Rule-
// stateful, session/intraday, order-flow and bracket-driven strategies are more
// natural as the stateful strategy(ctx) form (JS); vectorised statistical/factor
// ideas read best as pandas signals(df) (Python). LAB_RESEARCH_LANG pins it.
const INTRADAY_HINT = /\bintraday\b|\bsession\b|opening[-\s]?range|\borb\b|scalp|\bvwap\b|\bbreakout\b|\d+[-\s]?min/i;
// Latency-sensitive / low-level ideas earn C++ when g++ is installed; explicit
// kdb/q ideas earn q when the q binary is present. Otherwise: intraday → JS,
// everything else → Python. Cortex never writes a language it can't validate.
const HFT_HINT = /\bhft\b|high[-\s]?frequency|latency|microsecond|nanosecond|tick[-\s]?level|order[-\s]?book|market[-\s]?making|microstructur|order[-\s]?flow/i;
const Q_HINT = /\bkdb\b|kdb\+|\bq\/kdb|columnar|time[-\s]?series database/i;
function pickLang(item) {
  if (process.env.LAB_RESEARCH_LANG) return RESEARCH_LANG; // explicit pin wins
  const hay = `${item?.title || ""} ${(item?.topics || []).join(" ")} ${item?.abstract || ""}`;
  if (NATIVE_TOOLS.q && Q_HINT.test(hay)) return "q";
  if (HFT_HINT.test(hay)) return NATIVE_TOOLS.cpp ? "cpp" : "js";
  return INTRADAY_HINT.test(hay) ? "js" : "python";
}

// Quality bar (both tunable): a promoted market must beat buy&hold Sharpe by at
// least BH_SHARPE_MARGIN (not merely tie it), and its RECENT tail (last 30%) must
// be genuinely profitable — profitFactor ≥ HOLDOUT_MIN_PF and a positive return —
// so a strategy that decayed and only looks good over the full 10y is rejected.
const BH_SHARPE_MARGIN = +(process.env.LAB_BH_MARGIN || 0.10);
const HOLDOUT_MIN_PF = +(process.env.LAB_HOLDOUT_PF || 1.0);
// Absolute quality floor: a promoted market must clear a real risk-adjusted bar,
// not merely beat buy&hold — the goal is strategies a quant would actually find
// attractive (Sharpe ≈ 1+), not marginal ones. Tunable via LAB_MIN_SHARPE.
const MIN_SHARPE = +(process.env.LAB_MIN_SHARPE || 1.0);

// Compile a strategy to a signalFn regardless of language: Python goes through
// Pyodide (vectorised signals(df), memoised per candle array — a drop-in for the
// JS compiler), JS through the classic per-bar compiler. Every backtest, k-fold,
// noise and delay probe below funnels through here, so the gauntlet itself never
// has to know which language it's judging.
function compileFor(code, lang) {
  if (lang === "python") return compilePyStrategy(code);
  if (lang === "cpp") return compileCppStrategy(code); // g++ compiles once, runs per candle array
  if (lang === "q") return compileQStrategy(code);
  return compileStrategy(code);
}
// Small synthetic series to force one evaluation in the compile check (so a
// runtime error surfaces cheaply, before the gauntlet spends trials).
const _CHK_CANDLES = (() => {
  const o = []; let p = 100, t = 1_600_000_000;
  for (let i = 0; i < 240; i++) { p *= 1 + Math.sin(i / 11) * 0.01; o.push({ time: t + i * 3600, open: p * 0.999, high: p * 1.003, low: p * 0.997, close: p, volume: 1000 }); }
  return o;
})();
// Throwing compile+run check — the language-aware twin of `try { compileStrategy }`.
function compileCheckFor(code, lang) {
  if (lang === "python") return pyCompileCheck(code);
  if (lang === "cpp" || lang === "q") { compileFor(code, lang)({ candles: _CHK_CANDLES, index: 0 }); return true; }
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


// ── parameter plateau gate + cautious neighbor adoption (optimizer.mjs) ─────
// Applied to every gauntlet survivor: probe the parameter neighborhood (±25%
// per constant) on its best market. Knife-edge passes — where most neighbors
// lose money — are REJECTED: a lone parameter spike is luck in disguise.
// A neighbor that beats the original on the k-fold OOS criterion earns ONE
// full re-gauntlet; it is adopted only if it passes with DSR >= the original.
// Every probe and the re-gauntlet are charged to the DSR trial window.
function applyPlateau(code, language, verdict, st, datasetsUsed) {
  const ds = datasetsUsed.find((d) => d.market.id === verdict.bestMarket) || datasetsUsed[0];
  if (!ds) return { ok: true, summary: "no dataset", code, verdict, optimized: null };
  const probe = plateauProbe({ code, language, dataset: ds, compileFor, runBacktest, kFoldCode });
  for (let i = 0; i < probe.probes; i++) st.attemptLog = [...(st.attemptLog || []), Date.now()].slice(-5000);
  if (!probe.ok) return { ok: false, summary: probe.summary, code, verdict, optimized: null };
  if (probe.better) {
    st.attempts++;
    st.attemptLog = [...(st.attemptLog || []), Date.now()].slice(-5000);
    const v2 = gauntlet(probe.better.code, datasetsUsed, windowTrials(st), language);
    if (v2.pass && (v2.dsr ?? 0) >= (verdict.dsr ?? 0)) {
      return { ok: true, summary: probe.summary, code: probe.better.code, verdict: v2, optimized: probe.better.changed };
    }
  }
  return { ok: true, summary: probe.summary, code, verdict, optimized: null };
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
// ── local LLM router (OmniRoute) ────────────────────────────────────────────
// With LAB_LLM_URL set (e.g. http://localhost:20128/v1), every generation call
// runs through the local multi-provider router: the SITE still composes the
// prompts (promptOnly — one source of truth, keys stay server-side), the
// router executes them across its free-provider cascade, and this agent
// post-processes with the same shared helpers the server uses. Any failure
// falls back to the site's own provider chain — nothing gets less reliable.
const LLM_URL = (process.env.LAB_LLM_URL || "").replace(/\/+$/, "");
// The models this nightly agent requests from OmniRoute. CRITICAL: do NOT use
// `auto/coding` / `auto/reasoning` / `auto/best-*` here — those route to the
// STRONGEST model available, which becomes your Claude Code Opus SUBSCRIPTION
// once it's connected. A nightly agent reading many papers would burn it fast.
// Default to a concrete FREE model; override with LAB_LLM_MODEL if your OmniRoute
// names it differently. Any failure falls back to the site's provider chain.
const LLM_MODEL = process.env.LAB_LLM_MODEL || "groq/llama-3.3-70b-versatile";
const LLM_CRITIQUE_MODEL = process.env.LAB_LLM_CRITIQUE_MODEL || LLM_MODEL;

async function callLocalRouter(system, user, model) {
  const res = await fetch(`${LLM_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model, stream: false, max_tokens: 4000,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`router HTTP ${res.status}`);
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error("router empty reply");
  return text;
}

/**
 * One AI call: local router first (prompts from the site), site chain as
 * fallback. Returns the same shape the site returns ({code, language} or
 * {critique}); throws with .skip on rate limits like the old direct calls.
 */
async function aiCall(payload) {
  if (LLM_URL) {
    try {
      const pRes = await fetch(`${SITE}/api/generate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, promptOnly: true }),
      });
      const p = await pRes.json().catch(() => ({}));
      if (pRes.ok && p.user) {
        const text = await callLocalRouter(p.system || "", p.user, (p.isCritique || p.isCodeReview) ? LLM_CRITIQUE_MODEL : LLM_MODEL);
        if (p.isCritique) return { critique: parseVerdict(text) };
        if (p.isCodeReview) return { codeReview: parseCodeReview(text) };
        const out = extractCode(text);
        // ensureStrategyFn wraps JS only; python/cpp/q pass through untouched.
        const wrap = !["python", "cpp", "q"].includes(String(p.language));
        return { code: wrap ? ensureStrategyFn(out) : out, language: p.language };
      }
    } catch (e) {
      console.log(`  ~ local router failed (${String(e.message || "").slice(0, 50)}) — falling back to site AI`);
    }
  }
  const res = await fetch(`${SITE}/api/generate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (res.ok && (out.code || out.critique || out.codeReview)) return out;
  const e = new Error(out.error || `generate HTTP ${res.status}`);
  if (res.status === 429 || out.error === "rate_limited") e.skip = true;
  throw e;
}

async function generateStrategy(item) {
  // Full text where we could get it, abstract otherwise. `research` is a
  // separate endpoint channel because a document does not fit the 2000-char
  // prompt cap — truncating it there would undo the whole point of reading it.
  const text = (item.fullText && item.fullText.length > item.abstract.length)
    ? item.fullText
    : item.abstract;
  const language = pickLang(item); // Cortex chooses JS vs Python per idea
  const payload = {
    token: TOKEN,
    language,
    research: { title: item.title.slice(0, 200), kind: item.kind || "document", text },
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const out = await aiCall(payload);
      if (out.code) return { code: out.code, language: out.language || language };
      throw new Error("no code in reply");
    } catch (e) {
      if (e.skip && attempt < 3) { console.log(`  rate-limited, retry ${attempt}/2 in ${attempt * 45}s…`); await sleep(attempt * 45000); continue; }
      throw e;
    }
  }
}

// Self-repair: when generated code won't even compile, send it back once with
// the error and ask the model to fix the signature/format. One extra call, only
// on failure — cheap insurance against a model that ignored the naming contract.
async function repairStrategy(code, error, language = RESEARCH_LANG) {
  const out = await aiCall({ token: TOKEN, language, repair: { code: String(code).slice(0, 8000), error: String(error).slice(0, 300) } });
  if (out.code) return out.code;
  throw new Error("repair: no code in reply");
}

// Turn a gauntlet failure reason into targeted improvement guidance — the model
// gets told exactly WHICH weakness to fix, not just "do better".
function improveFacts(reason) {
  let hint = "";
  if (/^(audit|code-bug):/i.test(reason)) hint = "The CODE has a validity bug that makes the backtest meaningless — fix the logic itself, not the parameters. If it's a single-asset 'arbitrage'/negative-cycle, abandon that approach entirely and trade one clean mean-reversion or trend signal; if it's look-ahead, only use data up to the current close; if it's a constant signal, make the decision depend on the price; otherwise fix exactly the bug named in the reason.";
  else if (/timing-fragile/i.test(reason)) hint = "The edge collapsed when execution was delayed by one bar — remove any dependence on same-bar timing; act on signals CONFIRMED on the previous bar and hold positions longer.";
  else if (/k-?fold/i.test(reason)) hint = "Returns came from one lucky window — make the rule consistent across sub-periods (stronger regime filter, fewer/looser parameters).";
  else if (/noise/i.test(reason)) hint = "Tiny price perturbations destroyed it — widen thresholds/bands so entries never depend on exact price levels.";
  else if (/buy\s*&\s*hold/i.test(reason)) hint = "It underperformed simply holding the asset risk-adjusted — trade less often, be active only in the favourable regime, and/or add the short side.";
  else if (/holdout/i.test(reason)) hint = "It inverted on the most recent 30% of the data — reduce regime dependence; the rule must hold in the CURRENT market, not just the past.";
  else if (/dd\s/i.test(reason)) hint = "The drawdown is too deep — cut exposure with a volatility or regime filter instead of riding every move.";
  else if (/PF\s|DSR/i.test(reason)) hint = "The edge is too thin after costs — make entries more selective: higher-conviction setups, fewer trades.";
  return `Failed validation: ${reason}. ${hint}`;
}

// One improvement iteration via the site's AI endpoint (improve channel).
async function improveStrategy(g) {
  const language = g.language || RESEARCH_LANG;
  const out = await aiCall({
    token: TOKEN, language,
    improve: { code: String(g.code).slice(0, 8000), title: g.title, facts: improveFacts(g.reason || "") },
  });
  if (out.code) return { code: out.code, language: out.language || language };
  throw new Error("improve: no code in reply");
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
    // The RECENT tail must actually be PROFITABLE, not merely "not inverted": a
    // strategy that made its money years ago but is flat or bleeding lately is
    // decayed and shouldn't be traded now. (Tunable via LAB_HOLDOUT_PF.)
    if (m.profitFactor < HOLDOUT_MIN_PF || m.totalReturnPct <= 0) {
      return { ok: false, detail: `stale recent tail: PF ${m.profitFactor.toFixed(2)}, ret ${m.totalReturnPct.toFixed(0)}%` };
    }
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
    const out = await aiCall({ token: TOKEN, critique: { code, title: cand.name, facts } });
    if (out.critique) return out.critique;
  } catch (e) {
    console.error(`  committee review failed: ${e.message.slice(0, 50)}`);
  }
  return null;
}

// LLM CODE-review — reads a survivor's SOURCE for correctness bugs the statistical
// gauntlet cannot see (look-ahead, degenerate/tautological signals like the
// single-asset Bellman-Ford illusion, wrong indicator math). The deterministic
// auditStrategy is the cheap regex pre-filter in the gauntlet; this is the smart
// pass, run only on survivors (rare, cheap). Returns {verdict,bugs,...} or null.
async function reviewCode(code, cand, lang) {
  try {
    const out = await aiCall({ token: TOKEN, language: lang, codeReview: { code: String(code).slice(0, 7000), title: cand.name || cand.title || "strategy", language: lang } });
    return out.codeReview || null;
  } catch (e) {
    console.error(`  code-review failed: ${String(e.message || "").slice(0, 50)}`);
    return null;
  }
}

// Gate a survivor on the LLM code-review: a CRITICAL code bug means its numbers are
// an artifact (a great result from a broken strategy) — do not publish it. Attaches
// the review to the candidate for the UI, and returns the bury reason when blocked.
async function codeReviewGate(code, cand, lang) {
  const review = await reviewCode(code, cand, lang);
  if (review) {
    cand.codeReview = review;
    const crit = review.bugs.filter((b) => b.severity === "critical");
    if (crit.length) {
      console.log(`  🐞 code-review: ${crit.length} CRITICAL — ${crit[0].issue.slice(0, 80)}`);
      return `code-bug: ${crit[0].issue.slice(0, 90)}`;
    }
    if (review.bugs.length) console.log(`  🐞 code-review: ${review.bugs.length} warning(s) noted`);
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
  const out = { name: "", edge: "", works: "", breaks: "" };
  // Accept both comment styles so it works for JS (// EDGE:) and Python (# EDGE:).
  const re = /(?:\/\/|#)\s*(NAME|EDGE|WORKS|BREAKS)\s*:\s*(.+)/gi;
  let m;
  while ((m = re.exec(code))) {
    const key = m[1].toLowerCase();
    if (key in out) out[key] = m[2].trim().slice(0, 240);
  }
  return out;
}

function gauntlet(code, datasets, globalTrials, lang) {
  try { compileCheckFor(code, lang); } catch (e) { return { pass: false, reason: `compile: ${e.message.slice(0, 80)}` }; }

  // Code-VALIDITY audit BEFORE spending any trials — the statistical gauntlet grades
  // the results, this reads the CODE for logic defects that make those results a lie
  // (look-ahead, degenerate single-asset arbitrage that only triggers on float error,
  // a constant signal). A critical finding is rejected outright; warnings (e.g. no
  // risk exit) are carried onto the verdict so the survivor can be flagged/fixed.
  const audit = auditStrategy(code, lang);
  if (audit.blocked) {
    const c = audit.findings.find((f) => f.severity === "critical");
    return { pass: false, reason: `audit: ${c.id} — ${c.msg.slice(0, 90)}` };
  }

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
      // Name how wide the search actually was — "TSLA1d" in a failure line just
      // means TSLA was the closest of ALL tested venues, not the only one.
      reason: best
        ? `no edge on any of ${ran.length} markets (closest ${best.name}: ret ${best.m.totalReturnPct.toFixed(0)}%, PF ${best.m.profitFactor.toFixed(2)}, n=${best.m.tradeCount})`
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
    // (a) Absolute quality floor — must be genuinely attractive on its own, not
    // just positive. A quant ignores a Sharpe-0.4 strategy however you dress it.
    if (sh < MIN_SHARPE) {
      byMarket[r.name] = { ...mk, rejected: `Sharpe ${sh.toFixed(2)} < ${MIN_SHARPE} quality floor` };
      rejections.push(`${r.name}: Sharpe ${sh.toFixed(2)} below the ${MIN_SHARPE} quant-grade floor`);
      continue;
    }
    // (b) And it must still BEAT buy&hold by a margin — a great Sharpe that merely
    // matches holding the asset isn't worth the execution risk. (LAB_BH_MARGIN.)
    if (sh < bhS + BH_SHARPE_MARGIN) {
      byMarket[r.name] = { ...mk, rejected: `Sharpe ${sh.toFixed(2)} < buy&hold ${bhS.toFixed(2)} + ${BH_SHARPE_MARGIN}` };
      rejections.push(`${r.name}: doesn't clear buy & hold by margin (Sharpe ${sh.toFixed(2)} vs ${bhS.toFixed(2)}+${BH_SHARPE_MARGIN})`);
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
    return {
      pass: false,
      reason: `${promising.length}/${ran.length} markets promising, none survived — ${rejections[0] || "failed robustness"}`,
      byMarket, trials,
    };
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
    // Non-fatal code-audit warnings (e.g. no stop-loss) — surfaced on the survivor so
    // it can be flagged/improved rather than silently shipped.
    auditWarnings: audit.warnings ? audit.findings.filter((f) => f.severity === "warn").map((f) => f.id) : undefined,
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

// Run guard: two schedulers can exist (the lab agent's auto-spawn AND a
// separate n8n research workflow). If another research run started in the last
// 15 minutes, bow out — overlapping runs would double-spend LLM quota and
// double-count gauntlet trials. A crashed run blocks at most one cycle.
if (st.runStartedAt && Date.now() - st.runStartedAt < 15 * 60 * 1000) {
  console.log(`another research run started ${Math.round((Date.now() - st.runStartedAt) / 60000)}min ago — skipping (overlap guard)`);
  process.exit(0);
}
st.runStartedAt = Date.now();
save(st);

// The site's Always-On switch (Cortex tab bar). ON turns the barren tail of a
// run into the BUILD/IMPROVE phase below — Cortex keeps building strategy after
// strategy instead of idling when no fresh paper arrived. Offline → night mode.
let ALWAYS_ON = false;
try {
  const mr = await fetch(`${SITE}/api/lab?what=mode`, { headers: { "x-lab-token": TOKEN } });
  ALWAYS_ON = !!(await mr.json().catch(() => ({})))?.mode?.alwaysOn;
} catch { /* offline */ }
// In until-hit mode pull a deeper pool per source so there's enough supply.
const { items: harvested, counts: sourceCounts } = await harvestAll({ perSource: UNTIL_HIT ? 20 : 10 });
// Always-on = MANY SMALL runs (every ~30 min), so cap each one at the normal
// per-run budget even in until-hit mode — 48 daily runs at the until-hit cap
// would drain the free LLM tiers in an afternoon.
const limit = ALWAYS_ON ? MAX_PAPERS_PER_RUN : (UNTIL_HIT ? HARD_CAP : MAX_PAPERS_PER_RUN);

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
  .filter((p) => !JUNK.test(p.title || "")) // news/PR/signal-spam titles never carry a testable idea
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

// ── improve pool: near-misses worth iterating on (always-on only) ───────────
// A graveyard entry qualifies when its code RAN and traded but failed a quality
// gate (timing, k-fold, noise, holdout, buy&hold, profile bars) — those are one
// fix away from a candidate. Compile/generation garbage and "no edge anywhere"
// stay buried. Each idea gets at most MAX_IMPROVE_TRIES iterations.
const MAX_IMPROVE_TRIES = +(process.env.LAB_IMPROVE_TRIES || 3);
const IMPROVE_PER_RUN = +(process.env.LAB_IMPROVE_PER_RUN || 2);
const NOT_IMPROVABLE = /^(compile:|gen:|runtime|strategy error|no markets|no edge anywhere)/i;
const IMPROVABLE = /timing-fragile|k-?fold|noise|holdout|buy\s*&\s*hold|DSR|dd\s|PF\s/i;
const improvePool = ALWAYS_ON
  ? (st.graveyard || []).filter((g) =>
      g.code && (g.improveTries || 0) < MAX_IMPROVE_TRIES &&
      !NOT_IMPROVABLE.test(g.reason || "") && IMPROVABLE.test(g.reason || ""))
  : [];

// Always-improve: keep polishing CURRENT candidates until one can't be beaten,
// then declare it maxed out (👑). Round-robin (oldest-polished first), small
// budget per run so it never starves fresh research or the LLM pool.
const IMPROVE_MARGIN = +(process.env.LAB_IMPROVE_MARGIN || 3); // DSR points a rewrite must add to count as better
const POLISH_PER_RUN = Math.max(0, +(process.env.LAB_POLISH_PER_RUN ?? 1));
const polishPool = (ALWAYS_ON && POLISH_PER_RUN > 0)
  ? (st.candidates || [])
      .filter((c) => c.code && !c.maxed && (c.improveTries || 0) < MAX_IMPROVE_TRIES)
      .sort((a, b) => (a.lastPolishedAt || 0) - (b.lastPolishedAt || 0))
  : [];

// The full universe: crypto, equity index, single names, forex, across
// timeframes from 15m to daily. A strategy only has to work SOMEWHERE.
const datasets = (fresh.length || improvePool.length || polishPool.length) ? await loadUniverse(UNIVERSE) : [];

// Boot the Python runtime once, up front, if Cortex is writing Python and there
// is work to do — the whole gauntlet then runs signals(df) synchronously through
// this one Pyodide instance (numpy + pandas). ~3s, amortised over every backtest.
const needPy = RESEARCH_LANG === "python"
  ? (fresh.length || improvePool.length || polishPool.length)
  : polishPool.some((c) => c.language === "python"); // polishing a Python candidate needs Pyodide too
if (needPy) {
  const t = Date.now();
  await initPy((m) => console.log(`  ${m}`));
  console.log(`Python runtime ready in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

const newCandidates = [];
const touchedCandidates = []; // existing candidates the polish phase upgraded or maxed
const toPromote = [];

// Auto-promote per profile AND per winning market: a strategy that works on
// both EUR/USD daily and SOL 15m is two paper positions, not one — collapsing
// them to a single line would lie about what was validated. Shared by the
// fresh-paper loop and the always-on improve loop.
function queuePromotions(cand, verdict) {
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
        // Backtest expectation — the incubation watchdog in the lab agent
        // grades live paper behaviour against exactly this.
        expect: {
          retPct: verdict.byMarket[mid]?.ret ?? null,
          ddPct: verdict.byMarket[mid]?.dd ?? null,
          pf: verdict.byMarket[mid]?.pf ?? null,
          n: verdict.byMarket[mid]?.n ?? null,
        },
      });
      console.log(`  🤖 auto-promote queued: ${prof.label} · ${m.label}`);
    }
  }
}

// ── mentioned markets: if a paper POSITIVELY names a specific venue, test it ─
// A negative cue near the mention ("fails on", "doesn't work", "underperforms")
// keeps it out — the paper is telling us where NOT to look. Capped at 3 extras
// per paper; loaded once per run and cached across papers.
const NEG_MENTION = /\b(not|no|never|fails?|failed|doesn'?t|does not|underperform\w*|avoid|poor(ly)?|weak|negative|breaks? down|stops? work\w*|loses?|losing)\b/i;
function mentionedMarkets(text) {
  const hits = [];
  for (const m of MENTIONABLE) {
    const match = m.re.exec(text);
    if (!match) continue;
    const ctx = text.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80);
    if (!NEG_MENTION.test(ctx)) hits.push(m);
  }
  return hits.slice(0, 3);
}
const extraCache = new Map(); // market id → dataset (or null after a failed load)
async function loadMentioned(paper) {
  const text = `${paper.title} ${paper.fullText || paper.abstract || ""}`.slice(0, 20000);
  const out = [];
  for (const spec of mentionedMarkets(text)) {
    if (!extraCache.has(spec.id)) {
      const [ds] = await loadUniverse([spec]).catch(() => [null]);
      extraCache.set(spec.id, ds || null);
    }
    const ds = extraCache.get(spec.id);
    if (ds) out.push(ds);
  }
  if (out.length) console.log(`  ↳ paper mentions ${out.map((d) => d.name).join(", ")} — added to this gauntlet`);
  return out;
}

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
    const extras = await loadMentioned(paper);
    const verdict = gauntlet(code, [...datasets, ...extras], windowTrials(st), language);
    if (verdict.pass) {
      // Optimizer: plateau gate + cautious neighbor adoption.
      const plat = applyPlateau(code, language, verdict, st, [...datasets, ...extras]);
      if (!plat.ok) {
        st.graveyard = [{ title: paper.title.slice(0, 70), reason: `parameter knife-edge (${plat.summary})`, source: paper.source, link: paper.link, topics: paper.topics, code, language, improveTries: 0, at: Date.now() }, ...st.graveyard].slice(0, 200);
        console.log(`✗ knife-edge → graveyard: ${paper.title.slice(0, 50)} — ${plat.summary}`);
        verdict.pass = false; verdict.reason = "parameter knife-edge";
      } else {
        if (plat.optimized) console.log(`  🔧 optimizer: adopted neighbor ${plat.optimized} (re-gauntleted, DSR ${plat.verdict.dsr}%)`);
        code = plat.code;
        Object.assign(verdict, plat.verdict, { plateau: plat.summary, optimized: plat.optimized });
      }
    }
    if (verdict.pass) {
      const cand = {
        id: `rc_${Date.now().toString(36)}`,
        // Name it after what the RULE does, not after the article it came from —
        // "Bitcoin looks like Google did in its early days" told you nothing about
        // the strategy. cleanStrategyName rejects source-title / clickbait names
        // and derives a mechanism name (indicators + direction) from the code.
        name: cleanStrategyName(parseThesis(code).name, code, parseThesis(code).edge),
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

      // CODE-review gate — before crowning a survivor, have the LLM read its source
      // for correctness bugs the statistics can't see. A great result from broken
      // code (the Bellman-Ford float-glitch) is buried here, with the bug as the
      // reason so the improve loop can try to fix it.
      const codeBug = await codeReviewGate(code, cand, language);
      if (codeBug) {
        st.graveyard = [{ title: paper.title.slice(0, 70), reason: codeBug, source: paper.source, link: paper.link, topics: paper.topics, code, language, improveTries: 0, at: Date.now() }, ...st.graveyard].slice(0, 200);
        console.log(`✗ graveyard (code bug): ${paper.title.slice(0, 50)} — ${codeBug}`);
        continue;
      }

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

      queuePromotions(cand, verdict);
      if (UNTIL_HIT) { console.log(`  ↳ hit after ${processed} paper(s) — stopping early (until-hit mode)`); break; }
    } else {
      // Buried WITH its code + language + link, so the always-on improve loop
      // can pick the near-misses back up and iterate on them.
      st.graveyard = [{ title: paper.title.slice(0, 70), reason: verdict.reason, source: paper.source, link: paper.link, topics: paper.topics, code, language, improveTries: 0, at: Date.now() }, ...st.graveyard].slice(0, 200);
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

// ── always-on BUILD/IMPROVE phase ───────────────────────────────────────────
// With the site's Always-On switch ON, whatever budget the fresh papers didn't
// use goes into iterating near-misses: take a buried strategy that traded but
// failed ONE quality gate, feed it back with the specific failure, and send the
// improved version through the FULL gauntlet. Build → test → improve, strategy
// after strategy — Cortex never idles just because no new paper arrived.
// Honest accounting: every attempt is a trial (raises the DSR bar) like any
// other generation. improvePool entries reference st.graveyard directly, so
// updating them here persists via save(st).
let improvedThisRun = 0;
if (improvePool.length && datasets.length && !(UNTIL_HIT && newCandidates.length)) {
  console.log(`always-on: improve phase — ${improvePool.length} near-miss(es) in the pool, budget ${IMPROVE_PER_RUN}`);
  for (const g of improvePool) {
    if (improvedThisRun >= IMPROVE_PER_RUN) break;
    await sleep(20000); // same per-minute courtesy as generation
    try {
      const { code, language } = await improveStrategy(g);
      try { compileCheckFor(code, language); } catch (ce) {
        g.improveTries = (g.improveTries || 0) + 1;
        console.log(`✗ improve won't compile (${String(ce.message || "").slice(0, 40)}) — try ${g.improveTries}/${MAX_IMPROVE_TRIES}`);
        continue;
      }
      st.attempts++;
      st.attemptLog = [...(st.attemptLog || []), Date.now()].slice(-5000);
      const verdict = gauntlet(code, datasets, windowTrials(st), language);
      improvedThisRun++;
      if (verdict.pass) {
        const plat = applyPlateau(code, language, verdict, st, datasets);
        if (!plat.ok) { verdict.pass = false; verdict.reason = `parameter knife-edge (${plat.summary})`; }
        else Object.assign(verdict, { plateau: plat.summary });
      }
      if (verdict.pass) {
        const cand = {
          id: `ri_${Date.now().toString(36)}`,
          // Name from the improved CODE's mechanism, not the source title `g.title`
          // (which was the clickbait headline). Keep the "improved ·" provenance.
          name: `improved · ${cleanStrategyName(parseThesis(code).name, code, parseThesis(code).edge)}`.slice(0, 70),
          paper: g.link, source: g.source, kind: "improve",
          improvedFrom: g.title, topics: g.topics,
          code, language,
          thesis: parseThesis(code),
          byMarket: verdict.byMarket, markets: verdict.markets,
          bestMarket: verdict.bestMarket, marketsTested: verdict.marketsTested,
          trialsUsed: verdict.trials, dsr: verdict.dsr,
          profiles: verdict.qualified, trialsAtPass: st.attempts, foundAt: Date.now(),
        };
        console.log(`✓ IMPROVED → CANDIDATE: ${cand.name} (DSR ${cand.dsr}% on ${cand.bestMarket}) · profiles: ${verdict.qualified.join(", ")}`);
        cand.committee = await committeeReview(code, cand);
        st.candidates = [cand, ...st.candidates].slice(0, 30);
        newCandidates.push(cand);
        queuePromotions(cand, verdict);
        g.improveTries = MAX_IMPROVE_TRIES; // retire the base idea — it graduated
        g.reason = `improved → candidate ${cand.id}`;
      } else {
        g.improveTries = (g.improveTries || 0) + 1;
        g.code = code; g.language = language; // iterate from the latest attempt next time
        g.reason = verdict.reason; g.at = Date.now();
        console.log(`✗ improve try ${g.improveTries}/${MAX_IMPROVE_TRIES}: ${String(g.title).slice(0, 44)} — ${verdict.reason}`);
      }
    } catch (e) {
      if (e.skip) { console.log("~ improve phase paused (rate-limited)"); break; }
      g.improveTries = (g.improveTries || 0) + 1;
      console.log(`✗ improve failed: ${String(e.message || "").slice(0, 50)}`);
    }
  }
  st.improved = (st.improved || 0) + improvedThisRun;
}
save(st);

// ── always-on POLISH phase: keep improving CURRENT candidates until maxed ────
// "Cortex should always try to improve all current strats; only when it sees it
// probably reached the best possible version can it give up." Each run re-opens
// one candidate, asks for a STRICTLY better version, and either upgrades it in
// place (higher DSR) or, after MAX_IMPROVE_TRIES misses, crowns it MAXED OUT so
// it's left alone. Every attempt is charged to the trial window.
let polishedThisRun = 0;
if (polishPool.length && datasets.length) {
  console.log(`polish: ${polishPool.length} candidate(s) still improvable`);
  for (const cand of polishPool) {
    if (polishedThisRun >= POLISH_PER_RUN) break;
    cand.lastPolishedAt = Date.now();
    const baseDsr = cand.dsr ?? 0;
    try {
      const { code, language } = await improveStrategy({
        code: cand.code, title: cand.name, language: cand.language,
        reason: `already validated (DSR ${baseDsr}% on ${cand.bestMarket}); find a STRICTLY better version — higher risk-adjusted return and/or lower drawdown — WITHOUT changing the core edge`,
      });
      try { compileCheckFor(code, language); } catch { cand.improveTries = (cand.improveTries || 0) + 1; continue; }
      st.attempts++;
      st.attemptLog = [...(st.attemptLog || []), Date.now()].slice(-5000);
      const verdict = gauntlet(code, datasets, windowTrials(st), language);
      polishedThisRun++;
      let finalCode = code;
      if (verdict.pass) {
        const plat = applyPlateau(code, language, verdict, st, datasets);
        if (!plat.ok) verdict.pass = false;
        else { finalCode = plat.code; Object.assign(verdict, plat.verdict, { plateau: plat.summary }); }
      }
      if (verdict.pass && (verdict.dsr ?? 0) >= baseDsr + IMPROVE_MARGIN) {
        // A genuinely better version — replace the candidate in place and re-promote.
        Object.assign(cand, {
          code: finalCode, language, dsr: verdict.dsr, byMarket: verdict.byMarket,
          markets: verdict.markets, bestMarket: verdict.bestMarket, marketsTested: verdict.marketsTested,
          profiles: verdict.qualified, improveTries: 0, thesis: parseThesis(finalCode),
        });
        cand.name = cleanStrategyName(parseThesis(finalCode).name, finalCode) || cand.name;
        console.log(`⬆ POLISHED: ${cand.name} — DSR ${baseDsr}% → ${cand.dsr}%`);
        touchedCandidates.push(cand);
        queuePromotions(cand, verdict);
      } else {
        cand.improveTries = (cand.improveTries || 0) + 1;
        if (cand.improveTries >= MAX_IMPROVE_TRIES) {
          cand.maxed = true;
          touchedCandidates.push(cand);
          console.log(`👑 MAXED OUT: ${cand.name} — no better version after ${cand.improveTries} tries (DSR ${baseDsr}%)`);
        } else {
          console.log(`· polish miss ${cand.improveTries}/${MAX_IMPROVE_TRIES}: ${cand.name}`);
        }
      }
    } catch (e) {
      if (e.skip) { console.log("~ polish paused (rate-limited)"); break; }
      cand.improveTries = (cand.improveTries || 0) + 1;
      console.log(`✗ polish failed: ${String(e.message || "").slice(0, 50)}`);
    }
  }
  st.polished = (st.polished || 0) + polishedThisRun;
  save(st);
}

// ── always-on DATA-MINING phase (the second alpha channel) ──────────────────
// Papers are literature-driven; this channel scans OUR OWN market data for
// statistically robust anomalies (weekday / lag-1 autocorr / turn-of-month,
// discovered on the train 70% only) and sends the hits through the exact same
// gauntlet. Honest accounting: every NEW (market × family) scan is selection
// pressure and gets charged to the DSR trial window, and each gauntleted hit
// counts as an attempt like any paper strategy.
let minedThisRun = 0;
const MINE_PER_RUN = Math.max(0, +(process.env.LAB_MINE_PER_RUN ?? 1));
if (ALWAYS_ON && datasets.length && MINE_PER_RUN > 0 && !(UNTIL_HIT && newCandidates.length)) {
  st.minedKeys = st.minedKeys || [];
  st.scannedKeys = st.scannedKeys || [];
  const { hits, newScans, scanKeys, fdrDropped, fdrTests } = mineAnomalies(datasets, new Set(st.minedKeys), new Set(st.scannedKeys));
  if (fdrDropped > 0) console.log(`mining: FDR (BH, q=0.1 over ${fdrTests} tests) dropped ${fdrDropped} nominal hit(s) as likely false discoveries`);
  if (newScans > 0) {
    // Charge the scan breadth ONCE per new combo — scanning 40 combos and
    // keeping the best is multiple testing, and the DSR must know.
    for (let i = 0; i < newScans; i++) st.attemptLog = [...(st.attemptLog || []), Date.now()].slice(-5000);
    st.scannedKeys = [...new Set([...st.scannedKeys, ...scanKeys])].slice(-2000);
    console.log(`mining: charged ${newScans} new scan combos to the trial window`);
  }
  if (hits.length) console.log(`mining: ${hits.length} anomaly hit(s) above the pre-gauntlet hurdle`);
  for (const hit of hits) {
    if (minedThisRun >= MINE_PER_RUN) break;
    st.minedKeys = [...st.minedKeys, hit.key].slice(-500); // mined once, pass or fail
    try {
      compileCheckFor(hit.code, "js");
      st.attempts++;
      st.attemptLog = [...(st.attemptLog || []), Date.now()].slice(-5000);
      const verdict = gauntlet(hit.code, datasets, windowTrials(st), "js");
      minedThisRun++;
      if (verdict.pass) {
        const plat = applyPlateau(hit.code, "js", verdict, st, datasets);
        if (!plat.ok) { verdict.pass = false; verdict.reason = `parameter knife-edge (${plat.summary})`; }
        else {
          if (plat.optimized) console.log(`  🔧 optimizer: adopted neighbor ${plat.optimized}`);
          hit.code = plat.code;
          Object.assign(verdict, plat.verdict, { plateau: plat.summary, optimized: plat.optimized });
        }
      }
      if (verdict.pass) {
        const cand = {
          id: `rm_${Date.now().toString(36)}`,
          name: hit.name.slice(0, 70),
          paper: null, source: "data-mining", kind: "mined",
          minedStat: hit.stat, topics: ["anomaly", "data-mining"],
          code: hit.code, language: "js",
          thesis: parseThesis(hit.code),
          byMarket: verdict.byMarket, markets: verdict.markets,
          bestMarket: verdict.bestMarket, marketsTested: verdict.marketsTested,
          trialsUsed: verdict.trials, dsr: verdict.dsr,
          profiles: verdict.qualified, trialsAtPass: st.attempts, foundAt: Date.now(),
        };
        console.log(`✓ MINED → CANDIDATE: ${cand.name} (DSR ${cand.dsr}% on ${cand.bestMarket}) · ${hit.stat}`);
        cand.committee = await committeeReview(hit.code, cand);
        st.candidates = [cand, ...st.candidates].slice(0, 30);
        newCandidates.push(cand);
        queuePromotions(cand, verdict);
      } else {
        st.graveyard = [{ title: hit.name.slice(0, 70), reason: verdict.reason, source: "data-mining", topics: ["anomaly"], code: hit.code, language: "js", improveTries: 0, at: Date.now() }, ...st.graveyard].slice(0, 200);
        console.log(`✗ mined → graveyard: ${hit.name.slice(0, 50)} — ${verdict.reason}`);
      }
    } catch (e) {
      console.log(`✗ mined candidate broken (${String(e.message || "").slice(0, 50)}) — skipped`);
    }
  }
  st.mined = (st.mined || 0) + minedThisRun;
  save(st);
}

// ── intraday-template channel ───────────────────────────────────────────────
// Seed the gauntlet with the classic INTRADAY archetypes a day-trader runs —
// opening-range breakout, ADX trend (with the short side), VWAP reclaim, RSI-2
// in-trend, Supertrend, Donchian — so Cortex actively searches short-timeframe
// alpha and not just daily literature. Each template is tried ONCE (pass or
// fail), one per run, and is charged to the trial window like any other attempt.
let intradayThisRun = 0;
const INTRADAY_PER_RUN = Math.max(0, +(process.env.LAB_INTRADAY_PER_RUN ?? 1));
if (ALWAYS_ON && datasets.length && INTRADAY_PER_RUN > 0 && !(UNTIL_HIT && newCandidates.length)) {
  st.intradayKeys = st.intradayKeys || [];
  const pending = intradayTemplates(new Set(st.intradayKeys));
  if (pending.length) console.log(`intraday: ${pending.length} template(s) not yet tried`);
  for (const tpl of pending) {
    if (intradayThisRun >= INTRADAY_PER_RUN) break;
    st.intradayKeys = [...st.intradayKeys, tpl.key].slice(-100); // tried once, pass or fail
    try {
      compileCheckFor(tpl.code, "js");
      st.attempts++;
      st.attemptLog = [...(st.attemptLog || []), Date.now()].slice(-5000);
      const verdict = gauntlet(tpl.code, datasets, windowTrials(st), "js");
      intradayThisRun++;
      let code = tpl.code;
      if (verdict.pass) {
        const plat = applyPlateau(code, "js", verdict, st, datasets);
        if (!plat.ok) { verdict.pass = false; verdict.reason = `parameter knife-edge (${plat.summary})`; }
        else {
          if (plat.optimized) console.log(`  🔧 optimizer: adopted neighbor ${plat.optimized}`);
          code = plat.code;
          Object.assign(verdict, plat.verdict, { plateau: plat.summary, optimized: plat.optimized });
        }
      }
      if (verdict.pass) {
        const cand = {
          id: `rt_${Date.now().toString(36)}`,
          name: tpl.name.slice(0, 70),
          paper: null, source: "intraday-template", kind: "intraday",
          topics: ["intraday", "template"],
          code, language: "js",
          thesis: parseThesis(code),
          byMarket: verdict.byMarket, markets: verdict.markets,
          bestMarket: verdict.bestMarket, marketsTested: verdict.marketsTested,
          trialsUsed: verdict.trials, dsr: verdict.dsr,
          profiles: verdict.qualified, trialsAtPass: st.attempts, foundAt: Date.now(),
        };
        console.log(`✓ INTRADAY → CANDIDATE: ${cand.name} (DSR ${cand.dsr}% on ${cand.bestMarket})`);
        cand.committee = await committeeReview(code, cand);
        st.candidates = [cand, ...st.candidates].slice(0, 30);
        newCandidates.push(cand);
        queuePromotions(cand, verdict);
      } else {
        st.graveyard = [{ title: tpl.name.slice(0, 70), reason: verdict.reason, source: "intraday-template", topics: ["intraday"], code, language: "js", improveTries: 0, at: Date.now() }, ...st.graveyard].slice(0, 200);
        console.log(`✗ intraday → graveyard: ${tpl.name.slice(0, 50)} — ${verdict.reason}`);
      }
    } catch (e) {
      console.log(`✗ intraday template broken (${String(e.message || "").slice(0, 50)}) — skipped`);
    }
  }
  st.intraday = (st.intraday || 0) + intradayThisRun;
  save(st);
}

// Read the current lab state ONCE — used both to gate promotion on portfolio
// health (RiskGate) and to preserve paper state when we merge our summary in.
const cur = await (await fetch(`${SITE}/api/lab`, { headers: { "x-lab-token": TOKEN } })).json().catch(() => ({}));

// candidates always accumulate on the site — include the ones the polish phase
// upgraded or crowned (maxed) so their new code / 👑 flag reaches the Registry.
const pushCandidates = [...newCandidates];
for (const c of touchedCandidates) if (!pushCandidates.some((x) => x.id === c.id)) pushCandidates.push(c);
if (pushCandidates.length) {
  const r = await fetch(`${SITE}/api/lab`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, candidates: pushCandidates }),
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
  improved: st.improved || 0,
  mined: st.mined || 0,
  intraday: st.intraday || 0,
  polished: st.polished || 0,
  maxed: (st.candidates || []).filter((c) => c.maxed).length,
  alwaysOn: ALWAYS_ON,
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
