// research-agent.mjs — the autonomous research loop (Threepio phase 4).
// Scheduled by n8n (e.g. daily). Each run:
//
//   1. HARVEST: pull the newest quant papers from arXiv (q-fin, free API)
//   2. EXTRACT: for promising unseen papers, ask the site's own AI codegen
//      (/api/generate — key stays server-side, Gemini free tier) to turn the
//      abstract into a testable strategy(ctx) in the site's contract
//   3. VALIDATE: compile → backtest on two markets → k-fold consistency →
//      price-noise robustness → Deflated Sharpe with a GLOBAL trial counter
//      (every strategy ever generated raises the bar — honest data-mining
//      accounting, López de Prado style)
//   4. STORE: survivors → pushed to the site (lab:candidates, accumulating);
//      failures → local graveyard with the reason. Summary → lab:state.research
//
// The LLM proposes; the math disposes. All virtual, not investment advice.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runBacktest, compileStrategy } from "../src/lib/backtest.js";
import { kFoldCode, noiseTest, deflatedSharpe, equityReturns } from "../src/lib/validation.js";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
const RESEARCH_FILE = join(homedir(), ".mmmxcix-research.json");
const MAX_PAPERS_PER_RUN = +(process.env.LAB_RESEARCH_PAPERS || 2); // gentle on the free AI tier
const FEE_BPS = 10;
// Auto-promotion: a survivor whose Deflated Sharpe clears this (stricter than
// the 95% gauntlet gate) is pushed straight into the paper portfolio, up to a
// server-enforced cap. The math earns the promotion; no human click needed.
const AUTO_PROMOTE_DSR = +(process.env.LAB_AUTO_PROMOTE_DSR || 97);
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

// ── 1. harvest — MULTIPLE sources, like the real 3PO (not just arXiv) ────────
// Each paper is tagged with the research topics it touches; those tags both
// decide relevance and become the EDGES of the brain-vault knowledge graph.
const TOPICS = [
  { name: "momentum", re: /\bmomentum\b/i },
  { name: "reversal", re: /reversal|mean.?reversion|overreaction/i },
  { name: "trend", re: /\btrend|breakout\b/i },
  { name: "volatility", re: /volatilit|garch|\bvix\b/i },
  { name: "seasonality", re: /seasonal|calendar effect|day.of.week|turn.of.month/i },
  { name: "factor", re: /\bfactor|cross.?section|anomal|alpha\b/i },
  { name: "intraday", re: /intraday|high.frequency|microstructure|order.?flow/i },
  { name: "pairs/arb", re: /pairs trading|cointegrat|stat.?arb|arbitrage/i },
  { name: "ml", re: /machine learning|neural|deep learning|reinforcement|lstm|transformer/i },
  { name: "risk", re: /drawdown|tail risk|hedg|value.at.risk|\bvar\b/i },
  { name: "prediction", re: /predict|forecast|drift|signal/i },
];
const topicsOf = (text) => TOPICS.filter((t) => t.re.test(text)).map((t) => t.name);

async function harvestArxiv(max) {
  const cats = ["q-fin.TR", "q-fin.PM", "q-fin.ST", "q-fin.CP", "q-fin.RM", "q-fin.MF"];
  const q = cats.map((c) => `cat:${c}`).join("+OR+");
  const url = `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`;
  const xml = await (await fetch(url, { headers: { "user-agent": "mmmxcix-research/0.2" } })).text();
  const out = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const pick = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]?.replace(/\s+/g, " ").trim() || "";
    const id = pick("id");
    if (!id) continue;
    const title = pick("title"), abstract = pick("summary");
    out.push({ id, title, abstract, published: pick("published"), link: id, source: "arXiv", topics: topicsOf(`${title} ${abstract}`) });
  }
  return out;
}

// OpenAlex — free, no key, ~250M works. Abstracts arrive as an inverted index
// (word → positions) which we reconstruct. mailto = the polite request pool.
function reconstructAbstract(inv) {
  if (!inv || typeof inv !== "object") return "";
  const words = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  return words.join(" ").replace(/\s+/g, " ").trim();
}
async function harvestOpenAlex(max) {
  const url = `https://api.openalex.org/works?search=quantitative+trading+strategy+market+anomaly&sort=publication_date:desc&per-page=${max}&mailto=admin@mmmxcix.com`;
  const data = await (await fetch(url, { headers: { "user-agent": "mmmxcix-research/0.2" } })).json();
  const out = [];
  for (const w of data?.results || []) {
    const title = (w.title || "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    const abstract = reconstructAbstract(w.abstract_inverted_index);
    const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, "") : "";
    out.push({
      id: w.id, title, abstract, published: w.publication_date || "",
      link: doi ? `https://doi.org/${doi}` : w.id, source: "OpenAlex", topics: topicsOf(`${title} ${abstract}`),
    });
  }
  return out;
}

// Merge sources, interleaved for diversity, deduped by normalised title.
async function harvest(maxPerSource) {
  const [a, o] = await Promise.all([
    harvestArxiv(maxPerSource).catch((e) => { console.error("arXiv:", e.message); return []; }),
    harvestOpenAlex(maxPerSource).catch((e) => { console.error("OpenAlex:", e.message); return []; }),
  ]);
  const seen = new Set();
  const merged = [];
  const max = Math.max(a.length, o.length);
  for (let i = 0; i < max; i++) {
    for (const arr of [a, o]) {
      const p = arr[i];
      if (!p) continue;
      const key = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 60);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(p);
    }
  }
  console.log(`sources: arXiv ${a.length}, OpenAlex ${o.length} → ${merged.length} unique`);
  return merged;
}

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
  const cNodes = (st.candidates || []).slice(0, 30).map((c) => ({
    id: c.id, label: (c.name || "").slice(0, 52), outcome: "candidate",
    source: c.source || "?", topics: c.topics || [], dsr: c.dsr,
  }));
  const gNodes = (st.graveyard || []).slice(0, CAP - cNodes.length).map((g, i) => ({
    id: `g_${i}`, label: (g.title || "").slice(0, 52), outcome: "graveyard",
    source: g.source || "?", topics: g.topics || [], reason: g.reason,
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
async function generateStrategy(paper) {
  const abstract = paper.abstract.slice(0, 1250);
  const prompt =
    `Research paper: "${paper.title.slice(0, 160)}". Abstract: ${abstract}\n\n` +
    `Extract the single most testable systematic trading rule implied by this paper and implement it ` +
    `as strategy(ctx). Keep it SIMPLE (max 3 parameters, hardcoded as const). Long and/or short. ` +
    `Prefer robust logic over precision. Name nothing after the paper; just implement the rule.`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${SITE}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, prompt }),
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

// ── 3. data + validation gauntlet ───────────────────────────────────────────
async function fetchCrypto(symbol, interval, bars) {
  let out = [], end = Date.now();
  while (out.length < bars) {
    const rows = await (await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${end}&limit=1000`)).json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    out = [...rows.map((r) => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })), ...out];
    end = rows[0][0] - 1;
    if (rows.length < 1000) break;
  }
  return out.slice(-bars);
}
async function fetchStock(symbol) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=10y&interval=1d`,
    { headers: { "user-agent": "Mozilla/5.0" } });
  const r = (await res.json())?.chart?.result?.[0];
  const ts = r?.timestamp || [], q = r?.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return out;
}

/** Run the full gauntlet. Returns { pass, reason, metrics } */
function gauntlet(code, datasets, globalTrials) {
  let fn;
  try { fn = compileStrategy(code); } catch (e) { return { pass: false, reason: `compile: ${e.message.slice(0, 80)}` }; }

  const perSet = [];
  for (const { name, candles } of datasets) {
    let res;
    try {
      res = runBacktest({ candles, signalFn: compileStrategy(code), initialCapital: 10000, feeBps: FEE_BPS });
    } catch (e) {
      return { pass: false, reason: `runtime(${name}): ${e.message.slice(0, 60)}` };
    }
    if (res.warnings.length) return { pass: false, reason: `strategy error (${name}): ${res.warnings[0].slice(0, 80)}` };
    const m = res.metrics;
    perSet.push({ name, m, equity: res.equity });
    if (m.tradeCount < 20) return { pass: false, reason: `only ${m.tradeCount} trades on ${name} (need ≥20)` };
  }

  // must be profitable after costs on BOTH datasets
  for (const s of perSet) {
    if (s.m.totalReturnPct <= 0 || s.m.profitFactor <= 1.05) {
      return { pass: false, reason: `no edge on ${s.name} (ret ${s.m.totalReturnPct.toFixed(0)}%, PF ${s.m.profitFactor.toFixed(2)})` };
    }
  }

  // k-fold + noise on the primary set
  const primary = datasets[0];
  const kf = kFoldCode({ candles: primary.candles, makeSignalFn: () => compileStrategy(code), feeBps: FEE_BPS });
  if (!kf || kf.verdict !== "pass") return { pass: false, reason: `k-fold fail (${kf ? kf.profitableFolds + "/" + kf.totalFolds : "n/a"} folds)` };
  const nz = noiseTest({ candles: primary.candles, makeSignalFn: () => compileStrategy(code), runs: 15, feeBps: FEE_BPS });
  if (!nz || nz.verdict !== "pass") return { pass: false, reason: `noise fail (median ${nz ? nz.medianReturnPct.toFixed(0) : "?"}%)` };

  // deflated sharpe with the GLOBAL attempt count — the honest hurdle
  const dsr = deflatedSharpe(equityReturns(perSet[0].equity), Math.max(1, globalTrials));
  if (!dsr || dsr.dsr < 0.95) return { pass: false, reason: `DSR ${(dsr ? dsr.dsr * 100 : 0).toFixed(1)}% < 95% @ ${globalTrials} trials` };

  return {
    pass: true,
    metrics: Object.fromEntries(perSet.map((s) => [s.name, {
      ret: +s.m.totalReturnPct.toFixed(1), pf: +s.m.profitFactor.toFixed(2),
      dd: +s.m.maxDrawdownPct.toFixed(1), n: s.m.tradeCount,
    }])),
    dsr: +(dsr.dsr * 100).toFixed(1),
  };
}

// ── main ────────────────────────────────────────────────────────────────────
const st = load();
// In until-hit mode pull a deeper pool per source so there's enough supply.
const papers = await harvest(UNTIL_HIT ? 40 : 15);
const limit = UNTIL_HIT ? HARD_CAP : MAX_PAPERS_PER_RUN;
const fresh = papers.filter((p) => !st.seen.includes(p.id) && (p.topics?.length > 0)).slice(0, limit);
console.log(`papers: ${papers.length} harvested, ${fresh.length} fresh+promising this run${UNTIL_HIT ? ` (until-hit, cap ${HARD_CAP})` : ""}`);

const datasets = fresh.length
  ? [
      { name: "BTC4h", candles: await fetchCrypto("BTCUSDT", "4h", 6000) },
      { name: "SPY1d", candles: await fetchStock("SPY") },
    ]
  : [];

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
        topics: paper.topics,
        code,
        metrics: verdict.metrics,
        dsr: verdict.dsr,
        trialsAtPass: st.attempts,
        foundAt: Date.now(),
      };
      st.candidates = [cand, ...st.candidates].slice(0, 20);
      newCandidates.push(cand);
      console.log(`✓ CANDIDATE: ${cand.name} (DSR ${cand.dsr}%)`);
      // Auto-promote the strongest survivors straight into the paper portfolio.
      if (cand.dsr >= AUTO_PROMOTE_DSR) {
        toPromote.push({
          id: cand.id, name: `🤖 ${cand.name}`, mode: "code", code: cand.code,
          market: "crypto", symbol: "BTCUSDT", interval: "4h",
          feeBps: FEE_BPS, positionPct: 100, dsr: cand.dsr, paper: cand.paper,
        });
        console.log(`  🤖 auto-promote queued (DSR ${cand.dsr}% ≥ ${AUTO_PROMOTE_DSR}%)`);
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

// auto-promotion — gated by RiskGate: don't add risk to a full or drawn-down
// book (portfolio health from the paper agent's last report).
let promoteHold = "";
const rg = cur?.state?.riskgate;
if (rg) {
  const openN = rg.activeLimits?.openPositions ?? 0, maxN = rg.rules?.maxSimultaneousPositions ?? 5;
  const dd = rg.activeLimits?.combinedDrawdownPct ?? 0, maxDd = rg.rules?.maxCombinedDrawdownPct ?? 20;
  if (openN >= maxN) promoteHold = `portfolio full (${openN}/${maxN})`;
  else if (dd > maxDd) promoteHold = `drawdown ${dd}% > ${maxDd}%`;
}
if (toPromote.length && !promoteHold) {
  const r = await fetch(`${SITE}/api/lab`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, promote: toPromote }),
  });
  const o = await r.json().catch(() => ({}));
  st.autoPromoted = (st.autoPromoted || 0) + toPromote.length; save(st);
  console.log(`🤖 auto-promoted ${toPromote.length} → paper portfolio (active autos: ${o.autoActive ?? "?"}/${o.cap ?? "?"})`);
} else if (toPromote.length) {
  console.log(`🚦 auto-promotion held by RiskGate: ${promoteHold} — ${toPromote.length} kept as candidates`);
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
  lastRun: Date.now(),
  latest: fresh.map((p) => ({ title: p.title.slice(0, 80), link: p.link, source: p.source })),
  lastGraveyard: st.graveyard.slice(0, 3).map((g) => ({ title: g.title, reason: g.reason })),
} };
const push = await fetch(`${SITE}/api/lab`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: TOKEN, state }),
});
const hitThisRun = newCandidates.length > 0;
if (UNTIL_HIT && !hitThisRun) console.log(`until-hit: no survivor in ${processed} papers (cap ${HARD_CAP} / supply exhausted) — will resume next run`);
console.log(`research run done: read ${processed}, attempts total ${st.attempts}, graveyard ${st.graveyard.length}, candidates ${st.candidates.length} → push ${(await push.json().catch(() => ({}))).ok ? "ok" : "FAILED"}`);
