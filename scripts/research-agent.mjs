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
import { kFoldCode, noiseTest, deflatedSharpe, equityReturns, signalIC } from "../src/lib/validation.js";
import { auditStrategy } from "../src/lib/strategyAudit.js";
import { qualifyPooledAll, getProfile, PROFILE_IDS } from "../src/lib/profiles.js";
import {
  dailyReturnsOf, dailyCloseReturns, poolDaily, sharpeDaily, maxDrawdownPctDaily,
  totalReturnPctDaily, foldsProfitable, tailStats, corrDaily, pooledProfitFactor,
  compactSeries, ensembleGrade,
} from "../src/lib/ensemble.js";
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

// Replication (reel #14 / the XAU teardown): on the unseen tail the signal must not
// ANTI-predict. A near-zero IC is tolerated (asymmetric payoffs are legitimate), but
// a clearly negative out-of-sample IC means the "edge" reproduces backwards. Tunable.
const OOS_IC_FLOOR = +(process.env.LAB_OOS_IC || -0.02);
// ── Tier-1 geometry (docs/CORTEX_BENCHMARK.md, user-approved Aug 21) ─────────
// The old per-market Sharpe-1.0 / beat-B&H walls sat at the search's own noise
// ceiling (78% of near-misses died there at median best Sharpe 0.38) — a single
// rule on a single market realistically carries 0.2–0.5, and only overfits can
// clear 1.0. Rules are now graded on their POOLED daily returns across the
// whole universe (breadth does the statistical lifting); survivors combine into
// the ENSEMBLE book, and the quant-grade bars (Sharpe ≥ 1, beat buy&hold) apply
// to THAT book — where they are achievable and meaningful. Pooled bars live in
// profiles.js (judgePooled); the floor is env-tunable:
//   LAB_MIN_POOLED_SHARPE  (0.30)  pooled after-cost Sharpe floor per rule
//   LAB_ENSEMBLE_MARKETS   (2)     paper legs a promoted rule trades
//   LAB_ENSEMBLE_CORR_CAP  (0.7)   |ρ| above which a rule must beat the member it clones
const ENSEMBLE_MARKETS = Math.max(1, +(process.env.LAB_ENSEMBLE_MARKETS || 2));
const ENSEMBLE_CORR_CAP = +(process.env.LAB_ENSEMBLE_CORR_CAP || 0.7);

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

// Bury with hygiene: replace a same-title corpse instead of stacking a
// duplicate, and when the cap forces evictions, evict code-LESS corpses first.
// Entries that carry code are the improve loop's raw material — letting
// code-less tombstones (e.g. a revalidation sweep's) flood them out is what
// starved the always-on improve phase to an empty pool in Aug 2026.
const GRAVE_CAP = 200;
function bury(st, entry) {
  const rest = [entry, ...(st.graveyard || []).filter((g) => g.title !== entry.title)];
  if (rest.length > GRAVE_CAP) {
    let drop = rest.length - GRAVE_CAP;
    const keep = [];
    for (let i = rest.length - 1; i >= 0; i--) {         // oldest → newest
      if (drop > 0 && !rest[i].code) { drop--; continue; } // shed code-less first
      keep.unshift(rest[i]);
    }
    st.graveyard = keep.slice(0, GRAVE_CAP);             // all carry code → oldest go
  } else {
    st.graveyard = rest;
  }
}

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

// ── daily LLM budget (the fix for the Aug-2026 drought) ─────────────────────
// Every supply we have is DAILY-capped and shared: the router's groq models and
// the site's GROQ_API_KEY are the same free account (200k tokens/day), and the
// site's other provider is Mistral's free tier. Running 48 times a day and
// spending up to 8 calls per run, Cortex burned the whole day's quota within the
// first hour and then spent the remaining 47 runs sleeping through retries
// against a wall. So the budget is now explicit, persisted per UTC day, and a
// spent day is recognised ONCE instead of rediscovered every 30 minutes.
const LLM_DAILY_CALLS = +(process.env.LAB_LLM_DAILY_CALLS || 45);
const LLM_FAIL_STREAK = +(process.env.LAB_LLM_FAIL_STREAK || 3);
// How long a day declared "spent" stays closed before one probe call re-checks.
const LLM_RETRY_AFTER_MS = +(process.env.LAB_LLM_RETRY_AFTER_MIN || 90) * 60000;
let _budgetState = null;
function llmBudget() {
  const day = new Date().toISOString().slice(0, 10);
  if (!_budgetState || _budgetState.day !== day) {
    const prior = st?.llmDay?.day === day ? st.llmDay : null;
    _budgetState = prior || { day, calls: 0, fails: 0, exhausted: false };
    if (st) st.llmDay = _budgetState;
  }
  if (!_budgetState.exhausted && _budgetState.calls >= LLM_DAILY_CALLS) {
    markExhausted(`daily LLM call budget reached (${_budgetState.calls}/${LLM_DAILY_CALLS})`);
  }
  // Re-open on a schedule. "Exhausted" is inferred from refusals, and a refusal
  // can also mean a transient outage or a provider that refills on a rolling
  // window rather than at midnight — so without this, one bad half-hour would
  // idle Cortex for the rest of the day. A probe costs a single call.
  const since = Date.now() - (_budgetState.closedAt || 0);
  if (_budgetState.exhausted && _budgetState.calls < LLM_DAILY_CALLS && since > LLM_RETRY_AFTER_MS) {
    _budgetState.exhausted = false;
    _budgetState.fails = 0;
    deadModels.clear();
    console.log(`  ↻ LLM budget re-opened for a probe (closed ${Math.round(since / 60000)}min ago)`);
  }
  return _budgetState;
}

/** Close the day's LLM work, stamping WHEN — the re-probe window runs from here. */
function markExhausted(why) {
  if (!_budgetState) return;
  _budgetState.exhausted = true;
  _budgetState.closedAt = Date.now();
  console.log(`  ⛔ ${why} — Cortex switches to LLM-free work`);
}
/** Is there any point starting an LLM phase at all? */
const llmAvailable = () => !llmBudget().exhausted;

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
// The models this nightly agent requests from OmniRoute, tried IN ORDER.
//
// CRITICAL: never put `auto/*`, `cc/*`, `claude/*` or `aug/*` here — those route
// to the strongest model available, i.e. the user's Claude Code SUBSCRIPTION. A
// nightly agent reading papers around the clock would burn it in a day.
//
// Why a LIST (Aug 2026): a single model was a single point of failure and the
// measured reality is that free tiers die constantly — groq/openai/gpt-oss-120b
// hits "tokens per day (TPD): Limit 200000" and is then dead until midnight,
// groq/openai/gpt-oss-20b is MISROUTED inside OmniRoute (it answers with an
// error about the retired llama-3.3-70b-versatile), and every other free
// provider in the router replied 401/404/410. Only these survive a real probe,
// so the cascade tries each and remembers which ones are dead for this run.
const SAFE_LLM_MODELS = "groq/openai/gpt-oss-120b,nvidia/openai/gpt-oss-20b,nvidia/openai/gpt-oss-120b";
const SUBSCRIPTION_ALIAS = /^(auto|cc|claude|aug|no-think)\//i;
const LLM_MODELS = (() => {
  const raw = (process.env.LAB_LLM_MODELS || process.env.LAB_LLM_MODEL || SAFE_LLM_MODELS)
    .split(",").map((s) => s.trim()).filter(Boolean);
  const safe = raw.filter((m) => !SUBSCRIPTION_ALIAS.test(m));
  const dropped = raw.filter((m) => SUBSCRIPTION_ALIAS.test(m));
  if (dropped.length) {
    // This is not hypothetical: LAB_LLM_MODEL was found set to "auto/coding" in
    // the machine environment, which routes every nightly call to the strongest
    // model available — i.e. the Claude Code subscription. Refuse it, say so
    // loudly, and fall back to the free cascade rather than to nothing.
    console.log(`  ⚠ ignoring subscription-routing model(s) [${dropped.join(", ")}] from the environment — a nightly agent must not spend the Claude subscription. Set LAB_LLM_MODELS to concrete free models instead.`);
  }
  return safe.length ? safe : SAFE_LLM_MODELS.split(",");
})();
// A strategy is ~1.5k characters. 4000 max_tokens bought nothing and cost a lot:
// Groq bills its rate limiter on the ESTIMATE, which includes max_tokens, so an
// oversized ceiling was burning the daily cap roughly twice as fast as needed.
const LLM_MAX_TOKENS = +(process.env.LAB_LLM_MAX_TOKENS || 1800);
// Per-model timeout. Short enough that a cascade of three still fits inside the
// old single-model budget — a queued provider must not eat the whole run.
const LLM_TIMEOUT_MS = +(process.env.LAB_LLM_TIMEOUT_MS || 45000);
// Strikes before a model is retired FOR THIS RUN. A dying free tier does not
// announce itself with a tidy 429 — it also answers with empty bodies and hangs
// until the timeout. Counting only the tidy refusals meant every single call
// re-paid three timeouts (~4 minutes) and the run never concluded the supply
// was gone. Any failure is a strike; two strikes and the model sits out.
const LLM_STRIKES = +(process.env.LAB_LLM_STRIKES || 2);

// Errors that mean "this supply is gone for today" rather than "try again in a
// moment". Sleeping on a DAILY cap is pure waste — the old code burned 135s of
// retry sleeps per paper, 48 times a day, against a quota that resets at midnight.
const DAILY_CAP_RE = /per day|TPD|daily limit|quota exceeded|insufficient_quota/i;
const HARD_DEAD_RE = /HTTP (401|402|403|404|410)/;

const deadModels = new Set();   // models retired for THIS RUN
const modelStrikes = new Map(); // model → failures so far this run

async function callLocalRouter(system, user, model) {
  const res = await fetch(`${LLM_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model, stream: false, max_tokens: LLM_MAX_TOKENS,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Carry the provider's own words: "tokens per day (TPD): Limit 200000" is
    // the difference between a useful log line and a mystery.
    const detail = (await res.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
    const e = new Error(`router HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  const text = j?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error("router empty reply");
  return text;
}

/** Walk the model cascade; returns the first real reply. Throws if all fail. */
async function callRouterCascade(system, user) {
  const live = LLM_MODELS.filter((m) => !deadModels.has(m));
  if (!live.length) throw new Error("all router models dead this run");
  let last = null;
  for (const model of live) {
    try {
      return await callLocalRouter(system, user, model);
    } catch (e) {
      const msg = String(e.message || "");
      last = e;
      const strikes = (modelStrikes.get(model) || 0) + 1;
      modelStrikes.set(model, strikes);
      // A daily cap or a hard 4xx is terminal immediately; everything else
      // (empty bodies, hangs) retires the model after LLM_STRIKES attempts, so
      // one run can never spend minutes re-probing the same dead provider.
      const terminal = DAILY_CAP_RE.test(msg) || HARD_DEAD_RE.test(msg);
      if (terminal || strikes >= LLM_STRIKES) {
        deadModels.add(model);
        console.log(`  ~ ${model} out after ${strikes} (${msg.slice(0, 80)})`);
      } else {
        console.log(`  ~ ${model} failed (${msg.slice(0, 60)})`);
      }
    }
  }
  throw last || new Error("router cascade exhausted");
}

/**
 * One AI call: local router cascade first (prompts from the site), site chain as
 * fallback. Returns the same shape the site returns ({code, language} or
 * {critique}); throws with .skip on rate limits like the old direct calls.
 */
async function aiCall(payload) {
  const budget = llmBudget();
  if (budget.exhausted) {
    const e = new Error(`llm budget spent for today (${budget.calls} calls, ${budget.fails} failures)`);
    e.skip = true;
    e.budget = true;
    throw e;
  }
  // Skip the local router entirely while it is known-dead. Its free models hang
  // to the timeout rather than refusing cleanly, so re-discovering that costs
  // ~90s of wall clock at the start of EVERY run — 48 times a day — while the
  // site chain answers in ~2.5s. The flag rides the same UTC day + 90-minute
  // re-probe window as the token budget, so a recovered router comes back.
  const routerRested = budget.routerDeadAt && Date.now() - budget.routerDeadAt < LLM_RETRY_AFTER_MS;
  if (LLM_URL && LLM_MODELS.length && !routerRested && deadModels.size < LLM_MODELS.length) {
    try {
      const pRes = await fetch(`${SITE}/api/generate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, promptOnly: true }),
      });
      const p = await pRes.json().catch(() => ({}));
      if (pRes.ok && p.user) {
        const text = await callRouterCascade(p.system || "", p.user);
        budget.calls++;
        if (p.isCritique) return { critique: parseVerdict(text) };
        if (p.isCodeReview) return { codeReview: parseCodeReview(text) };
        const out = extractCode(text);
        // ensureStrategyFn wraps JS only; python/cpp/q pass through untouched.
        const wrap = !["python", "cpp", "q"].includes(String(p.language));
        return { code: wrap ? ensureStrategyFn(out) : out, language: p.language };
      }
    } catch (e) {
      console.log(`  ~ router unavailable (${String(e.message || "").slice(0, 60)}) — trying site AI`);
      if (deadModels.size >= LLM_MODELS.length && !budget.routerDeadAt) {
        budget.routerDeadAt = Date.now();
        console.log(`  ~ router rested for ${Math.round(LLM_RETRY_AFTER_MS / 60000)}min — every model is out; the site chain carries the load`);
      }
    }
  }
  const budget2 = llmBudget();
  let res, out;
  try {
    res = await fetch(`${SITE}/api/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    out = await res.json().catch(() => ({}));
  } catch (e) {
    budget2.fails++;
    const err = new Error(`site AI unreachable: ${String(e.message || e).slice(0, 60)}`);
    err.skip = true;
    throw err;
  }
  if (res.ok && (out.code || out.critique || out.codeReview)) { budget2.calls++; return out; }
  const e = new Error(out.error || `generate HTTP ${res.status}`);
  if (res.status === 429 || out.error === "rate_limited") {
    e.skip = true;
    // Both supplies refusing = the free tiers are spent. Record it so the rest
    // of the run (and the rest of the day) stops paying for the same answer.
    // The site chain is the LAST resort: if it refuses this many times in a
    // row, the supply is gone whatever the router is doing. (Requiring the
    // router to be fully retired as well meant a router that merely hangs kept
    // the day "open" forever.)
    budget2.fails++;
    if (budget2.fails >= LLM_FAIL_STREAK) {
      markExhausted(`LLM supply spent (${budget2.fails} straight refusals)`);
    }
  }
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
  // ONE short retry, and only for a transient refusal. The old code slept 45s
  // then 90s on every rate limit — but our limits are DAILY, so those 135s
  // bought nothing and were paid 48 times a day. A spent budget fails instantly.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await aiCall(payload);
      if (out.code) return { code: out.code, language: out.language || language };
      throw new Error("no code in reply");
    } catch (e) {
      if (e.skip && !e.budget && attempt < 2) { console.log("  refused — one retry in 20s…"); await sleep(20000); continue; }
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
  else if (/holdout|stale recent tail/i.test(reason)) hint = "It decayed — flat or bleeding on the most recent 30% of the data. Reduce regime dependence; the rule must hold in the CURRENT market, not just the past.";
  else if (/dd\s|drawdown/i.test(reason)) hint = "The drawdown is too deep — cut exposure with a volatility or regime filter instead of riding every move.";
  else if (/pooled Sharpe/i.test(reason)) hint = "The POOLED risk-adjusted return across the whole universe is below the floor. Breadth is the lever: uncorrelated legs lift pooled Sharpe by roughly √N, so make the rule PORTABLE — relative, ATR/percentile-scaled conditions instead of asset-specific price levels, keep both long and short sides, and add a regime filter so it sits flat where the edge is absent instead of bleeding there.";
  else if (/quality floor|quant-grade|Sharpe\s+[\d.]+\s*(?:<|below)/i.test(reason)) hint = "The risk-adjusted return is below the floor — add a regime/volatility filter so it is only active when the edge exists, cut the losing trades (tighter invalidation), and stay flat in chop; raising Sharpe by trading less is fine.";
  else if (/only \d+(?:\.\d+)? trades|trades\/yr|pooled|barely trades/i.test(reason)) hint = "The sample is too thin — the rule fires too rarely. Make the trigger fire more often WITHOUT degrading quality: relative conditions (crossovers, bands, percentiles) instead of rare absolute setups, allow both sides, and make it work on more markets.";
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
 * The gauntlet, Tier-1 geometry: one rule = ONE portfolio, its daily returns
 * pooled equal-weight across every market it ran on.
 *
 * Why (docs/CORTEX_BENCHMARK.md): the old per-market walls (Sharpe ≥ 1.0,
 * beat B&H per venue) demanded from a single rule on a single market what only
 * overfits deliver — 78% of near-misses died there at a median best Sharpe of
 * 0.38, and E[max noise Sharpe] at our trial count was ≈1.1, i.e. the wall sat
 * at the search's own noise ceiling. Pooling every tested venue (no selection,
 * so no cherry-picking and no market-cluster trial multiplier) is what turns a
 * genuine 0.3-Sharpe edge into a statistically confirmable object, and the
 * quant-grade bars move to the ensemble book where they are achievable.
 *
 * The robustness suite survives intact — delay retention ≥50% (pooled), k-fold
 * (pooled folds), noise (top contributors), holdout tail + OOS IC (pooled),
 * DSR at the windowed trial count — plus the pooled profile bars in
 * profiles.js (PF, drawdown, 300-trade and trades/yr floors).
 *
 * Costs are still per market: 15-minute equity pays far more spread than
 * daily, and a flat 10bps everywhere would flatter exactly the noise.
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

// Warnings that do NOT invalidate a run. The engine's "Bracket sanity" note is
// informational — a trailing stop overtaken by a weekend gap fills at the open,
// which is honest. Shared by the normal and the delayed path so both judge a
// leg by the same standard (see delayedPool below for why that matters).
const fatalWarnings = (res) => res.warnings.filter((w) => !w.includes("Bracket sanity"));

// One-bar-delayed run of a single leg — the execution-robustness probe.
// Returns the leg's delayed DAILY returns, or null if the delayed run failed.
function delayedDailyOf(code, leg, lang) {
  try {
    const inner = compileFor(code, lang);
    let prev = "flat";
    const fn = (ctx) => { const s = inner(ctx); const out = prev; prev = s; return out; };
    const res = runBacktest({ candles: leg.candles, signalFn: fn, initialCapital: 10000, feeBps: leg.feeBps });
    return fatalWarnings(res).length ? null : dailyReturnsOf(res.equity);
  } catch { return null; }
}

/**
 * Pooled normal-vs-delayed Sharpe over exactly the SAME legs.
 *
 * The subtle way to get this wrong (and the way I got it wrong first): compute
 * the delayed pool over whichever legs happened to survive, and compare it to a
 * normal pool built from all of them. Then the two numbers describe different
 * portfolios, and a rule whose per-market Sharpes barely move (0.39→0.40,
 * 0.60→0.62) reads as a catastrophic 0.61→-1.00 collapse purely because a few
 * profitable legs dropped out of one side. Every leg that cannot produce a
 * delayed series is therefore excluded from BOTH sides.
 */
function delayedPool(code, ran, lang) {
  const keptNormal = [], keptDelayed = [];
  for (const r of ran) {
    const d = delayedDailyOf(code, r, lang);
    if (!d) continue;                       // unusable delayed → drop from both
    keptNormal.push(dailyReturnsOf(r.equity));
    keptDelayed.push(d);
  }
  if (!keptDelayed.length) return { base: 0, delayed: 0, legs: 0 };
  return {
    base: sharpeDaily(poolDaily(keptNormal).returns),
    delayed: sharpeDaily(poolDaily(keptDelayed).returns),
    legs: keptDelayed.length,
  };
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

  // HARD RISK-EXIT REQUIREMENT (user rule, Aug 9): a strategy without any
  // stop/trailing/target must never reach the paper book, however good its
  // numbers. Rejected HERE (the source) so a stop-less idea goes into the
  // improve pool with a reason that tells the next iteration exactly what to
  // add — instead of being promoted and then evicted by the library police.
  if (!/(stop|target|trailing|trail|\bsl\b|\btp\b)/i.test(code)) {
    return { pass: false, reason: "no hard stop-loss/trailing exit — add an ATR-based stop (+ trailing) or stop/target brackets; risk management is required before promotion" };
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
    // (The engine's "Bracket sanity" clamp note is informational — a trailing
    // stop overtaken by a weekend gap fills at the open, which is honest, not
    // fatal. Everything else, incl. the implausible-result warning, rejects.)
    const fatal = res.warnings.filter((w) => !w.includes("Bracket sanity"));
    if (fatal.length) return { pass: false, reason: `strategy error (${name}): ${fatal[0].slice(0, 70)}` };
    ran.push({ name, market, candles, feeBps, m: res.metrics, equity: res.equity, signals: res.signals, trades: res.trades });
  }

  if (!ran.length) return { pass: false, reason: "no markets ran" };

  // ── Tier-1 POOLED acceptance ────────────────────────────────────────────────
  // The rule is graded as ONE portfolio: its daily returns pooled (equal-weight
  // by calendar date) across EVERY market it ran on — no venue selection, so no
  // cherry-picking to punish, and the Deflated Sharpe trial count goes back to
  // being the windowed attempt count alone. Per-market rows are kept for the
  // record (where does it earn?), but no per-market wall can kill the rule.
  const pooledTrades = ran.reduce((s, r) => s + r.m.tradeCount, 0);
  const byMarket = summarise(ran);
  if (pooledTrades < 20) {
    return { pass: false, reason: `barely trades: ${pooledTrades} trades pooled across ${ran.length} markets`, byMarket };
  }

  const pooledSeries = poolDaily(ran.map((r) => dailyReturnsOf(r.equity)));
  const spanYears = Math.max(0.1, ...ran.map((r) => r.m.spanYears || 0));
  const pooled = {
    sharpe: sharpeDaily(pooledSeries.returns),
    pf: pooledProfitFactor(ran.map((r) => r.trades)),
    ddPct: maxDrawdownPctDaily(pooledSeries.returns),
    retPct: totalReturnPctDaily(pooledSeries.returns),
    trades: pooledTrades,
    tradesPerYear: pooledTrades / spanYears,
    obsDays: pooledSeries.returns.length,
  };
  const roundedPooled = {
    sharpe: +pooled.sharpe.toFixed(2), pf: +pooled.pf.toFixed(2),
    ddPct: +pooled.ddPct.toFixed(1), retPct: +pooled.retPct.toFixed(1),
    trades: pooled.trades, tradesPerYear: +pooled.tradesPerYear.toFixed(1),
    obsDays: pooled.obsDays,
  };
  const trials = globalTrials;
  const fail = (reason) => ({ pass: false, reason, byMarket, pooled: roundedPooled, trials });

  const MIN_POOLED_SHARPE = +(process.env.LAB_MIN_POOLED_SHARPE || 0.30);
  if (pooled.obsDays < 200) return fail(`only ${pooled.obsDays} pooled daily observations (need ≥200)`);
  if (pooled.sharpe < MIN_POOLED_SHARPE) {
    const best = ran.slice().sort((a, b) => (b.m.sharpe ?? 0) - (a.m.sharpe ?? 0))[0];
    return fail(
      `pooled Sharpe ${pooled.sharpe.toFixed(2)} < ${MIN_POOLED_SHARPE} across ${ran.length} markets` +
      ` (best single: ${best.name} ${(best.m.sharpe ?? 0).toFixed(2)})`
    );
  }

  // EXECUTION-TIMING ROBUSTNESS on the pool: every leg delayed one bar,
  // re-pooled. The retention bar (keep ≥50%) matches walk-forward-efficiency
  // doctrine and the measured live haircut — it stays, because it is the test
  // that separates real edges from fill-timing artifacts (ICT/BTC: +3086% → −43%).
  const del = delayedPool(code, ran, lang);
  const delSharpe = del.delayed;
  // Judged against the SAME-LEG baseline, not the full-universe pooled figure.
  if (delSharpe < Math.max(0.1, del.base * 0.5)) {
    return fail(`timing-fragile (pooled Sharpe ${del.base.toFixed(2)}→${delSharpe.toFixed(2)} on 1-bar delay, ${del.legs} legs)`);
  }

  // k-fold on the pooled series — pure math, no re-backtests.
  const kf = foldsProfitable(pooledSeries.returns, 5);
  if (kf.profitable < Math.ceil(kf.total * 0.6)) {
    return fail(`k-fold ${kf.profitable}/${kf.total} pooled folds profitable`);
  }

  // Price-noise robustness, spot-checked on the two biggest contributors (a
  // full pooled noise pass would be runs × markets backtests; the fragility it
  // hunts — entries pinned to exact price levels — shows up where the rule
  // actually trades).
  const contributors = ran.filter((r) => r.m.tradeCount >= 20)
    .sort((a, b) => (b.m.sharpe ?? 0) - (a.m.sharpe ?? 0)).slice(0, 2);
  for (const r of contributors) {
    const nz = noiseTest({ candles: r.candles, makeSignalFn: () => compileFor(code, lang), runs: 8, feeBps: r.feeBps });
    if (!nz || nz.verdict !== "pass") return fail(`noise (${r.name})`);
  }

  // Holdout: the POOLED recent tail must be profitable — a rule that made its
  // money years ago and bleeds now is decayed. And the signal must not
  // ANTI-predict out of sample (mean IC across legs ≥ floor) — the replication
  // check that catches backwards "edges".
  const tail = tailStats(pooledSeries.returns, 0.3);
  if (tail.n >= 60 && (tail.retPct <= 0 || tail.sharpe <= 0)) {
    return fail(`stale recent tail: pooled ret ${tail.retPct.toFixed(0)}%, Sharpe ${tail.sharpe.toFixed(2)} over the last 30%`);
  }
  const ics = [];
  for (const r of ran) {
    const cut = Math.floor(r.candles.length * 0.7);
    const { ic } = signalIC(r.candles.slice(cut), (r.signals || []).slice(cut));
    if (ic != null) ics.push(ic);
  }
  const meanIc = ics.length ? ics.reduce((a, b) => a + b, 0) / ics.length : null;
  if (meanIc != null && meanIc < OOS_IC_FLOOR) {
    return fail(`failed replication: mean OOS signal IC ${meanIc.toFixed(3)} across ${ics.length} markets`);
  }

  // Deflated Sharpe of the pooled daily returns at the windowed trial count.
  const dsrRaw = deflatedSharpe(pooledSeries.returns, trials);
  const dsrPct = dsrRaw ? dsrRaw.dsr * 100 : 0;

  const { qualified, reasons } = qualifyPooledAll({ pooled, dsrPct });
  if (!qualified.length) return fail(reasons.private || reasons.prop);

  // Where it EARNS (display + which legs the paper book trades): active,
  // positive-Sharpe legs, strongest first. Purely informational — acceptance
  // was pooled, so listing the good legs is reporting, not selection.
  const active = ran.filter((r) => r.m.tradeCount >= 20 && (r.m.sharpe ?? 0) > 0)
    .sort((a, b) => (b.m.sharpe ?? 0) - (a.m.sharpe ?? 0));
  for (const r of active) byMarket[r.name] = { ...byMarket[r.name], earns: true };
  const winningMarkets = active.map((r) => r.name);
  const best = winningMarkets[0] || ran[0].name;

  return {
    pass: true,
    byMarket,
    markets: winningMarkets,
    bestMarket: best,
    dsr: +dsrPct.toFixed(1),
    qualified,
    // The pooled portfolio object this rule was ACCEPTED on — the honest
    // headline. Per-market rows above are attribution, not the verdict.
    pooled: {
      ...roundedPooled,
      dsr: +dsrPct.toFixed(1),
      delayedSharpe: +delSharpe.toFixed(2),
      oosIc: meanIc != null ? +meanIc.toFixed(3) : null,
      kFold: `${kf.profitable}/${kf.total}`,
    },
    pooledDaily: compactSeries(pooledSeries),
    pooledMarkets: ran.map((r) => r.name),
    trials,
    marketsTested: datasets.length,
    // Non-fatal code-audit warnings (e.g. no stop-loss) — surfaced on the survivor so
    // it can be flagged/improved rather than silently shipped.
    auditWarnings: audit.warnings ? audit.findings.filter((f) => f.severity === "warn").map((f) => f.id) : undefined,
  };
}

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
// "no edge on any" is the gauntlet's actual wording (the old "no edge anywhere"
// never matched, so edgeless strategies leaked into the improve pool via the
// "PF 1.08" in their reason string while real near-misses were excluded).
const NOT_IMPROVABLE = /^(compile:|gen:|runtime|strategy error|no markets|no edge (on any|anywhere))/i;
// One fix away from a candidate: every QUALITY-gate failure qualifies — timing,
// k-fold, noise, holdout, buy&hold, DSR, the Sharpe quality floor (the dominant
// failure since the Aug bars), drawdown, and the sample floors (trade count /
// trades-per-year / pooled) — the improve prompt knows a targeted fix for each.
const IMPROVABLE = /timing-fragile|k-?fold|noise|holdout|stale recent tail|buy\s*&\s*hold|DSR|dd\s|PF\s|quality floor|quant-grade|Sharpe\s+[\d.]+\s*(?:<|below)|drawdown|only \d+(?:\.\d+)? trades|trades\/yr|pooled|barely trades|stop-?loss|risk management|failed replication/i;
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
const retireIds = []; // ensemble members replaced this run — their paper legs retire

// {dates, returns} → [{d, r}] pair list, the shape poolDaily consumes.
const toPairs = (s) => (s?.dates || []).map((d, i) => ({ d, r: s.returns[i] }));

// ── Tier-1 promotion: admit the RULE to the ensemble, then paper its legs ────
// A survivor joins the ensemble book only if it adds something: not a clone of
// a member (|ρ| cap — the WorldQuant/Carver self-correlation rule; a strictly
// better clone REPLACES its incumbent and retires the incumbent's paper legs)
// and never degrading the combined book. Admitted rules paper-trade their
// strongest ENSEMBLE_MARKETS legs, one entry per (profile × market), so the
// live book mirrors the pooled object that was actually validated.
function queuePromotions(cand, verdict) {
  if (!verdict.pooledDaily) return; // legacy verdict shape — nothing to admit
  st.ensemble = st.ensemble || { members: [] };
  const mine = verdict.pooledDaily;

  const clash = st.ensemble.members
    .map((m) => ({ m, rho: corrDaily(m.pooledDaily, mine) }))
    .filter((x) => x.rho != null && Math.abs(x.rho) > ENSEMBLE_CORR_CAP)
    .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))[0];
  if (clash) {
    if ((verdict.pooled?.sharpe ?? 0) <= (clash.m.sharpe ?? 0) * 1.1) {
      cand.ensembleNote = `held: ρ ${clash.rho.toFixed(2)} with "${clash.m.name}" and not clearly better`;
      console.log(`  ⛔ ensemble: ${cand.name} — ${cand.ensembleNote}`);
      return;
    }
    console.log(`  ↔ ensemble: ${cand.name} replaces correlated member "${clash.m.name}" (ρ ${clash.rho.toFixed(2)})`);
    st.ensemble.members = st.ensemble.members.filter((m) => m !== clash.m);
    if (clash.m.candId) retireIds.push(clash.m.candId);
  }

  // Marginal contribution: with ≥2 members, a new rule must not drag the book.
  const cur = st.ensemble.members.map((m) => toPairs(m.pooledDaily));
  if (cur.length >= 2) {
    const without = sharpeDaily(poolDaily(cur).returns);
    const withNew = sharpeDaily(poolDaily([...cur, toPairs(mine)]).returns);
    if (withNew < without - 0.02) {
      cand.ensembleNote = `held: would drag the book (Sharpe ${without.toFixed(2)} → ${withNew.toFixed(2)})`;
      console.log(`  ⛔ ensemble: ${cand.name} — ${cand.ensembleNote}`);
      return;
    }
  }

  st.ensemble.members = [
    ...st.ensemble.members,
    { candId: cand.id, name: cand.name, sharpe: verdict.pooled?.sharpe ?? 0, profiles: verdict.qualified, pooledDaily: mine, at: Date.now() },
  ].slice(-12); // bounded — a 12-rule book is already beyond both profile caps

  const legs = (verdict.markets || []).slice(0, ENSEMBLE_MARKETS);
  for (const pid of verdict.qualified) {
    const prof = getProfile(pid);
    if ((verdict.dsr ?? 0) < prof.promotion.minDsr) continue;
    for (const mid of legs) {
      const m = byId(mid);
      if (!m) continue;
      toPromote.push({
        id: `${cand.id}_${pid}_${mid}`, name: `🤖 ${cand.name} · ${m.label}`,
        mode: "code", code: cand.code, language: cand.language,
        market: m.asset === "crypto" ? "crypto" : "stock",
        symbol: m.symbol, interval: m.interval,
        feeBps: costFor(m), positionPct: 100,
        volTarget: true, // GARCH vol-targeted sizing — cuts drawdown by default
        dsr: verdict.dsr, paper: cand.paper,
        profile: pid, candidateId: cand.id, marketId: mid,
        ensembleRule: cand.id, // groups this leg under its rule in the book
        // The rule's POOLED record travels with every leg: the library police
        // (retest-library → progressEntry) judges a leg on this, never on the
        // leg's own Sharpe — otherwise it would bury the rule on day one.
        pooled: verdict.pooled,
        // Backtest expectation — the incubation watchdog in the lab agent
        // grades live paper behaviour against exactly this (per-leg numbers).
        expect: {
          retPct: verdict.byMarket[mid]?.ret ?? null,
          ddPct: verdict.byMarket[mid]?.dd ?? null,
          pf: verdict.byMarket[mid]?.pf ?? null,
          n: verdict.byMarket[mid]?.n ?? null,
        },
      });
      console.log(`  🤖 ensemble leg queued: ${prof.label} · ${m.label}`);
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
// Reading papers costs an LLM call each. With the budget spent, skip straight to
// the channels that need no model at all (mining, intraday templates) — a
// no-supply day should still produce tested strategies, not just log failures.
// The papers stay unseen, so tomorrow's budget gets them.
if (fresh.length && !llmAvailable()) {
  console.log(`llm budget spent — skipping ${fresh.length} fresh paper(s); they stay queued for the next window`);
}
for (const paper of (llmAvailable() ? fresh : [])) {
  if (!firstPaper) await sleep(20000); // stay under the free tier's per-minute cap
  firstPaper = false;
  processed++;
  try {
    let { code, language } = await generateStrategy(paper);
    // Self-repair probe: if it won't compile/run, ask the model to fix it once.
    // For Python this runs the code through Pyodide on a synthetic series.
    //
    // RATE-LIMIT POLICY for the repair calls: degrade, never abort. The old code
    // re-threw the skip, which kept the paper "fresh" — so the NEXT run re-spent
    // a full generation call on the same paper, hit the limit at the same spot,
    // and looped forever: the exact papers that needed repair burned the most
    // quota. Now a rate-limited repair just keeps the original code and lets the
    // gauntlet judge it — the paper is consumed honestly and its corpse (with
    // code) stays available to the improve loop. Only a rate-limited GENERATION
    // (no code produced at all) still keeps the paper fresh.
    let compiledOk = true;
    try {
      compileCheckFor(code, language);
    } catch (ce) {
      compiledOk = false;
      console.log(`  ⚠ won't compile (${ce.message.slice(0, 45)}) — repair attempt…`);
      try {
        const fixed = await repairStrategy(code, ce.message, language);
        compileCheckFor(fixed, language); // throws if still broken → keep original, gauntlet buries it
        code = fixed;
        compiledOk = true;
        console.log("  ✓ repaired");
      } catch (re) {
        if (re.skip) console.log("  ~ repair rate-limited — keeping original (gauntlet will judge it)");
        else console.log(`  ✗ repair failed (${String(re.message || "").slice(0, 40)})`);
      }
    }
    // Liveness repair: if the strategy barely trades, it is a degenerate
    // generation (a condition that never triggers), not a real idea. Give the
    // model ONE chance to make it actually fire — same self-repair pattern as
    // the compile fix, aimed squarely at the n=0/n=1 no-ops. Only keep the
    // rewrite if it genuinely trades more, so a failed repair can't make it worse.
    // Only for code that COMPILES: probing trades on broken code always reads 0,
    // so the old flow spent a guaranteed-useless LLM call right after a failed
    // compile repair.
    if (datasets.length && compiledOk) {
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
          if (re.skip) console.log("  ~ liveness repair rate-limited — keeping original (gauntlet will judge it)");
          else console.log(`  ✗ liveness repair failed (${String(re.message || "").slice(0, 40)})`);
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
        bury(st, { title: paper.title.slice(0, 70), reason: `parameter knife-edge (${plat.summary})`, source: paper.source, link: paper.link, topics: paper.topics, code, language, improveTries: 0, at: Date.now() });
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
        // was tried — attribution for the POOLED verdict the rule was actually
        // accepted on (pooled = the headline; pooledDaily feeds the ensemble's
        // correlation/marginal admission and stays LOCAL — stripped on push).
        byMarket: verdict.byMarket,
        markets: verdict.markets,
        bestMarket: verdict.bestMarket,
        marketsTested: verdict.marketsTested,
        pooled: verdict.pooled, pooledDaily: verdict.pooledDaily, pooledMarkets: verdict.pooledMarkets,
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
        bury(st, { title: paper.title.slice(0, 70), reason: codeBug, source: paper.source, link: paper.link, topics: paper.topics, code, language, improveTries: 0, at: Date.now() });
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
      bury(st, { title: paper.title.slice(0, 70), reason: verdict.reason, source: paper.source, link: paper.link, topics: paper.topics, code, language, improveTries: 0, at: Date.now() });
      console.log(`✗ graveyard: ${paper.title.slice(0, 50)} — ${verdict.reason}`);
    }
  } catch (e) {
    if (e.skip) {
      console.log(`~ skipped (infra: ${e.message}) — paper stays fresh for the next run`);
    } else {
      st.seen = [...st.seen, paper.id].slice(-500);
      bury(st, { title: paper.title.slice(0, 70), reason: `gen: ${e.message.slice(0, 60)}`, source: paper.source, topics: paper.topics, at: Date.now() });
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
if (improvePool.length && datasets.length && !(UNTIL_HIT && newCandidates.length) && llmAvailable()) {
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
          pooled: verdict.pooled, pooledDaily: verdict.pooledDaily, pooledMarkets: verdict.pooledMarkets,
          trialsUsed: verdict.trials, dsr: verdict.dsr,
          profiles: verdict.qualified, trialsAtPass: st.attempts, foundAt: Date.now(),
        };
        console.log(`✓ IMPROVED → CANDIDATE: ${cand.name} (DSR ${cand.dsr}% on ${cand.bestMarket}) · profiles: ${verdict.qualified.join(", ")}`);
        const codeBug = await codeReviewGate(code, cand, language);
        if (codeBug) {
          // The improved version has a code bug — treat as a failed improve so the
          // loop keeps iterating from it rather than publishing a broken strat.
          g.improveTries = (g.improveTries || 0) + 1;
          g.code = code; g.language = language; g.reason = codeBug; g.at = Date.now();
          console.log(`✗ improve produced a code bug (${g.improveTries}/${MAX_IMPROVE_TRIES}): ${codeBug}`);
        } else {
          cand.committee = await committeeReview(code, cand);
          st.candidates = [cand, ...st.candidates].slice(0, 30);
          newCandidates.push(cand);
          queuePromotions(cand, verdict);
          g.improveTries = MAX_IMPROVE_TRIES; // retire the base idea — it graduated
          g.reason = `improved → candidate ${cand.id}`;
        }
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
if (polishPool.length && datasets.length && llmAvailable()) {
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
          pooled: verdict.pooled, pooledDaily: verdict.pooledDaily, pooledMarkets: verdict.pooledMarkets,
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
          pooled: verdict.pooled, pooledDaily: verdict.pooledDaily, pooledMarkets: verdict.pooledMarkets,
          trialsUsed: verdict.trials, dsr: verdict.dsr,
          profiles: verdict.qualified, trialsAtPass: st.attempts, foundAt: Date.now(),
        };
        console.log(`✓ MINED → CANDIDATE: ${cand.name} (DSR ${cand.dsr}% on ${cand.bestMarket}) · ${hit.stat}`);
        const codeBug = await codeReviewGate(hit.code, cand, "js");
        if (codeBug) {
          bury(st, { title: hit.name.slice(0, 70), reason: codeBug, source: "data-mining", topics: ["anomaly"], code: hit.code, language: "js", improveTries: 0, at: Date.now() });
          console.log(`✗ mined → graveyard (code bug): ${hit.name.slice(0, 50)} — ${codeBug}`);
        } else {
          cand.committee = await committeeReview(hit.code, cand);
          st.candidates = [cand, ...st.candidates].slice(0, 30);
          newCandidates.push(cand);
          queuePromotions(cand, verdict);
        }
      } else {
        bury(st, { title: hit.name.slice(0, 70), reason: verdict.reason, source: "data-mining", topics: ["anomaly"], code: hit.code, language: "js", improveTries: 0, at: Date.now() });
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
          pooled: verdict.pooled, pooledDaily: verdict.pooledDaily, pooledMarkets: verdict.pooledMarkets,
          trialsUsed: verdict.trials, dsr: verdict.dsr,
          profiles: verdict.qualified, trialsAtPass: st.attempts, foundAt: Date.now(),
        };
        console.log(`✓ INTRADAY → CANDIDATE: ${cand.name} (DSR ${cand.dsr}% on ${cand.bestMarket})`);
        const codeBug = await codeReviewGate(code, cand, "js");
        if (codeBug) {
          bury(st, { title: tpl.name.slice(0, 70), reason: codeBug, source: "intraday-template", topics: ["intraday"], code, language: "js", improveTries: 0, at: Date.now() });
          console.log(`✗ intraday → graveyard (code bug): ${tpl.name.slice(0, 50)} — ${codeBug}`);
        } else {
          cand.committee = await committeeReview(code, cand);
          st.candidates = [cand, ...st.candidates].slice(0, 30);
          newCandidates.push(cand);
          queuePromotions(cand, verdict);
        }
      } else {
        bury(st, { title: tpl.name.slice(0, 70), reason: verdict.reason, source: "intraday-template", topics: ["intraday"], code, language: "js", improveTries: 0, at: Date.now() });
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
// try/catch around the fetch itself: a network outage here used to be an
// UNCAUGHT rejection that killed the whole run (ETIMEDOUT → process crash)
// after all the expensive work was already done.
let cur = {};
try { cur = await (await fetch(`${SITE}/api/lab`, { headers: { "x-lab-token": TOKEN } })).json(); } catch { /* offline → merge over nothing */ }

// candidates always accumulate on the site — include the ones the polish phase
// upgraded or crowned (maxed) so their new code / 👑 flag reaches the Registry.
const pushCandidates = [...newCandidates];
for (const c of touchedCandidates) if (!pushCandidates.some((x) => x.id === c.id)) pushCandidates.push(c);
if (pushCandidates.length) {
  try {
    // pooledDaily is the ensemble's local working data (thousands of floats) —
    // the site card doesn't need it and the KV budget can't afford it.
    const slim = pushCandidates.map(({ pooledDaily, ...rest }) => rest);
    const r = await fetch(`${SITE}/api/lab`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, candidates: slim }),
    });
    console.log(`candidates pushed: ${(await r.json().catch(() => ({}))).stored ?? "?"} stored on site`);
  } catch (e) { console.error(`candidates push failed: ${e.message} — kept locally, next run re-pushes`); }
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
  try {
    const r = await fetch(`${SITE}/api/lab`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, promote: allowed }),
    });
    const o = await r.json().catch(() => ({}));
    st.autoPromoted = (st.autoPromoted || 0) + allowed.length; save(st);
    console.log(`🤖 auto-promoted ${allowed.length} → paper portfolio (active autos: ${o.autoActive ?? "?"}/${o.cap ?? "?"})`);
  } catch (e) { console.error(`promotion push failed: ${e.message}`); }
}
if (heldNotes.length) {
  console.log(`🚦 auto-promotion held by RiskGate — ${[...new Set(heldNotes)].join("; ")}`);
}

// Paper legs of ensemble members that were REPLACED by a better-correlated twin
// this run — retire them so the book mirrors the current member set.
if (retireIds.length) {
  try {
    const r = await fetch(`${SITE}/api/lab`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, retire: { ids: retireIds } }),
    });
    const o = await r.json().catch(() => ({}));
    console.log(`retired ${o.retired ?? "?"} paper leg(s) of replaced ensemble member(s)`);
  } catch (e) { console.error(`retire push failed: ${e.message}`); }
}

// ── the ensemble book's grade — the level the hard quant-grade bars apply to ──
let ensembleReport = null;
try {
  const members = st.ensemble?.members || [];
  if (members.length) {
    const bh = datasets.length ? poolDaily(datasets.map((d) => dailyCloseReturns(d.candles))) : null;
    const g = ensembleGrade(members.map((m) => toPairs(m.pooledDaily)), bh);
    delete g.series;
    ensembleReport = {
      ...g,
      rules: members.length,
      members: members.map((m) => ({ name: m.name, sharpe: +(m.sharpe ?? 0).toFixed(2), profiles: m.profiles || [] })),
    };
    console.log(`ensemble book: ${members.length} rule(s) · Sharpe ${g.sharpe} vs B&H ${g.bhSharpe ?? "?"} · dd ${g.ddPct}% → ${g.quantGrade ? "QUANT-GRADE" : "building"}`);
  }
} catch (e) { console.error(`ensemble grade failed: ${e.message}`); }

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
  // LLM supply health — so a dead free tier is VISIBLE on the Coach page
  // instead of looking like "Cortex stopped researching".
  llm: {
    day: llmBudget().day,
    calls: llmBudget().calls,
    dailyCap: LLM_DAILY_CALLS,
    exhausted: !!llmBudget().exhausted,
    deadModels: [...deadModels],
    models: LLM_MODELS,
  },
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
  // Tier-1: the combined book of admitted rules and its grade against the
  // quant-grade bars (Sharpe ≥ 1, beat holding the universe) — the number the
  // Coach page should headline now, instead of any per-market stat.
  ensemble: ensembleReport,
  lastRun: Date.now(),
  latest: fresh.map((p) => ({ title: p.title.slice(0, 80), link: p.link, source: p.source, kind: p.kind })),
  lastGraveyard: st.graveyard.slice(0, 3).map((g) => ({ title: g.title, reason: g.reason })),
} };
let statePushOk = false;
try {
  const push = await fetch(`${SITE}/api/lab`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, state }),
  });
  statePushOk = !!(await push.json().catch(() => ({}))).ok;
} catch (e) { console.error(`state push failed: ${e.message}`); }
const hitThisRun = newCandidates.length > 0;
if (UNTIL_HIT && !hitThisRun) console.log(`until-hit: no survivor in ${processed} papers (cap ${HARD_CAP} / supply exhausted) — will resume next run`);
console.log(`research run done: read ${processed}, attempts total ${st.attempts}, graveyard ${st.graveyard.length}, candidates ${st.candidates.length} → push ${statePushOk ? "ok" : "FAILED"}`);
