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
import { validationDatasets } from "./marketdata.mjs";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
const RESEARCH_FILE = join(homedir(), ".mmmxcix-research.json");
const MAX_PAPERS_PER_RUN = +(process.env.LAB_RESEARCH_PAPERS || 2); // gentle on the free AI tier
const FEE_BPS = 10;
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
    research: { title: item.title.slice(0, 200), kind: item.kind || "document", text },
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${SITE}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.code) return out.code;
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
async function repairStrategy(code, error) {
  const res = await fetch(`${SITE}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, repair: { code: String(code).slice(0, 8000), error: String(error).slice(0, 300) } }),
  });
  const out = await res.json().catch(() => ({}));
  if (res.ok && out.code) return out.code;
  const e = new Error(out.error || `repair HTTP ${res.status}`);
  if (res.status === 429 || out.error === "rate_limited") e.skip = true;
  throw e;
}

// ── 3. validation gauntlet (candle fetchers live in marketdata.mjs) ─────────

/**
 * Run the full gauntlet ONCE and judge the result against BOTH profiles.
 *
 * The structural checks (compiles, runs, survives k-fold and noise) are
 * profile-independent — a strategy that crashes is not "prop-strict-crashing".
 * Only the numeric bars differ, so the expensive work happens once and
 * qualifyAll() reads the same metrics twice.
 *
 * @returns {{ pass:boolean, reason?:string, metrics?:object, dsr?:number,
 *             qualified?:string[], profileReasons?:object }}
 */
function gauntlet(code, datasets, globalTrials) {
  try { compileStrategy(code); } catch (e) { return { pass: false, reason: `compile: ${e.message.slice(0, 80)}` }; }

  const perSet = [];
  for (const { name, candles } of datasets) {
    let res;
    try {
      res = runBacktest({ candles, signalFn: compileStrategy(code), initialCapital: 10000, feeBps: FEE_BPS });
    } catch (e) {
      return { pass: false, reason: `runtime(${name}): ${e.message.slice(0, 60)}` };
    }
    if (res.warnings.length) return { pass: false, reason: `strategy error (${name}): ${res.warnings[0].slice(0, 80)}` };
    perSet.push({ name, m: res.metrics, equity: res.equity });
  }

  // Structural robustness first — cheap to state, and profile-independent.
  const primary = datasets[0];
  const kf = kFoldCode({ candles: primary.candles, makeSignalFn: () => compileStrategy(code), feeBps: FEE_BPS });
  if (!kf || kf.verdict !== "pass") return { pass: false, reason: `k-fold fail (${kf ? kf.profitableFolds + "/" + kf.totalFolds : "n/a"} folds)` };
  const nz = noiseTest({ candles: primary.candles, makeSignalFn: () => compileStrategy(code), runs: 15, feeBps: FEE_BPS });
  if (!nz || nz.verdict !== "pass") return { pass: false, reason: `noise fail (median ${nz ? nz.medianReturnPct.toFixed(0) : "?"}%)` };

  // Deflated Sharpe with the GLOBAL attempt count — the honest hurdle. Every
  // strategy ever generated raises this bar, so a lucky one found on attempt
  // 400 has to clear far more than one found on attempt 4.
  const dsrRaw = deflatedSharpe(equityReturns(perSet[0].equity), Math.max(1, globalTrials));
  const dsrPct = dsrRaw ? dsrRaw.dsr * 100 : 0;

  const { qualified, reasons } = qualifyAll({ perSet, dsrPct });
  const metrics = Object.fromEntries(perSet.map((s) => [s.name, {
    ret: +s.m.totalReturnPct.toFixed(1), pf: +s.m.profitFactor.toFixed(2),
    dd: +s.m.maxDrawdownPct.toFixed(1), n: s.m.tradeCount,
  }]));

  if (qualified.length === 0) {
    // Report the LEAST strict profile's reason — it is the most informative
    // ("PF 1.1 < 1.35" beats "drawdown 22% > 15%" when both regimes rejected it).
    const reason = reasons.private || reasons.prop || "failed all profiles";
    return { pass: false, reason, metrics, dsr: +dsrPct.toFixed(1) };
  }

  return {
    pass: true, metrics, dsr: +dsrPct.toFixed(1),
    qualified, profileReasons: reasons,
  };
}

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

const datasets = fresh.length ? await validationDatasets() : [];

const newCandidates = [];
const toPromote = [];
let firstPaper = true;
let processed = 0; // papers actually evaluated this run (may stop early on a hit)
for (const paper of fresh) {
  if (!firstPaper) await sleep(20000); // stay under the free tier's per-minute cap
  firstPaper = false;
  processed++;
  try {
    let code = await generateStrategy(paper);
    // Self-repair probe: if it won't compile, ask the model to fix it once.
    try {
      compileStrategy(code);
    } catch (ce) {
      console.log(`  ⚠ won't compile (${ce.message.slice(0, 45)}) — repair attempt…`);
      try {
        const fixed = await repairStrategy(code, ce.message);
        compileStrategy(fixed); // throws if still broken → keep original, gauntlet buries it
        code = fixed;
        console.log("  ✓ repaired");
      } catch (re) {
        if (re.skip) throw re; // rate-limited repair → treat as infra skip, paper stays fresh
        console.log(`  ✗ repair failed (${String(re.message || "").slice(0, 40)})`);
      }
    }
    st.seen = [...st.seen, paper.id].slice(-500); // only consumed once generation succeeded
    st.papersRead++;
    st.attempts++; // global data-mining counter — raises the DSR bar forever
    const verdict = gauntlet(code, datasets, st.attempts);
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
        metrics: verdict.metrics,
        dsr: verdict.dsr,
        // Which regimes this cleared. A strategy can be private-grade and still
        // breach a prop drawdown rule — that is information, not a failure.
        profiles: verdict.qualified,
        profileReasons: verdict.profileReasons,
        trialsAtPass: st.attempts,
        foundAt: Date.now(),
      };
      st.candidates = [cand, ...st.candidates].slice(0, 30);
      newCandidates.push(cand);
      console.log(`✓ CANDIDATE: ${cand.name} (DSR ${cand.dsr}%) → profiles: ${verdict.qualified.join(", ")}`);

      // Auto-promote per profile: each regime has its own DSR bar and its own
      // cap on the server, so a prop-grade survivor can be promoted into the
      // prop book even when the private book is already full.
      for (const pid of verdict.qualified) {
        const prof = getProfile(pid);
        if (cand.dsr >= prof.promotion.minDsr) {
          toPromote.push({
            id: `${cand.id}_${pid}`, name: `🤖 ${cand.name}`, mode: "code", code: cand.code,
            market: "crypto", symbol: "BTCUSDT", interval: "4h",
            feeBps: FEE_BPS, positionPct: 100, dsr: cand.dsr, paper: cand.paper,
            profile: pid, candidateId: cand.id,
          });
          console.log(`  🤖 auto-promote queued for ${prof.label} (DSR ${cand.dsr}% ≥ ${prof.promotion.minDsr}%)`);
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
