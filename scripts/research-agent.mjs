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
const MAX_PAPERS_PER_RUN = 3;   // stay well inside the free AI tier
const FEE_BPS = 10;

if (!TOKEN) { console.error("LAB_TOKEN is not set."); process.exit(1); }

// ── local research memory ───────────────────────────────────────────────────
function load() {
  try { return JSON.parse(readFileSync(RESEARCH_FILE, "utf8")); } catch {
    return { seen: [], attempts: 0, graveyard: [], candidates: [], papersRead: 0 };
  }
}
function save(st) { writeFileSync(RESEARCH_FILE, JSON.stringify(st)); }

// ── 1. harvest arXiv q-fin ──────────────────────────────────────────────────
const KEYWORDS = /momentum|reversal|mean.?reversion|trend|volatility|seasonal|anomal|predict|alpha|factor|intraday|breakout|pairs|cross.?section|overreaction|drift/i;

async function harvest() {
  const url = "https://export.arxiv.org/api/query?search_query=cat:q-fin.TR+OR+cat:q-fin.PM+OR+cat:q-fin.ST&sortBy=submittedDate&sortOrder=descending&max_results=25";
  const xml = await (await fetch(url, { headers: { "user-agent": "mmmxcix-research/0.1" } })).text();
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const pick = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]?.replace(/\s+/g, " ").trim() || "";
    const id = pick("id");
    entries.push({ id, title: pick("title"), abstract: pick("summary"), published: pick("published"), link: id });
  }
  return entries;
}

// ── 2. abstract → strategy code via the site's own AI endpoint ─────────────
async function generateStrategy(paper) {
  const abstract = paper.abstract.slice(0, 1250);
  const prompt =
    `Research paper: "${paper.title.slice(0, 160)}". Abstract: ${abstract}\n\n` +
    `Extract the single most testable systematic trading rule implied by this paper and implement it ` +
    `as strategy(ctx). Keep it SIMPLE (max 3 parameters, hardcoded as const). Long and/or short. ` +
    `Prefer robust logic over precision. Name nothing after the paper; just implement the rule.`;
  const res = await fetch(`${SITE}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, prompt }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.code) throw new Error(out.error || `generate HTTP ${res.status}`);
  return out.code;
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
const papers = await harvest();
const fresh = papers.filter((p) => !st.seen.includes(p.id) && KEYWORDS.test(p.title + " " + p.abstract)).slice(0, MAX_PAPERS_PER_RUN);
console.log(`arXiv: ${papers.length} papers, ${fresh.length} fresh+promising this run`);

const datasets = fresh.length
  ? [
      { name: "BTC4h", candles: await fetchCrypto("BTCUSDT", "4h", 6000) },
      { name: "SPY1d", candles: await fetchStock("SPY") },
    ]
  : [];

const newCandidates = [];
for (const paper of fresh) {
  st.seen = [...st.seen, paper.id].slice(-500);
  st.papersRead++;
  try {
    const code = await generateStrategy(paper);
    st.attempts++; // global data-mining counter — raises the DSR bar forever
    const verdict = gauntlet(code, datasets, st.attempts);
    if (verdict.pass) {
      const cand = {
        id: `rc_${Date.now().toString(36)}`,
        name: paper.title.slice(0, 70),
        paper: paper.link,
        code,
        metrics: verdict.metrics,
        dsr: verdict.dsr,
        trialsAtPass: st.attempts,
        foundAt: Date.now(),
      };
      st.candidates = [cand, ...st.candidates].slice(0, 20);
      newCandidates.push(cand);
      console.log(`✓ CANDIDATE: ${cand.name} (DSR ${cand.dsr}%)`);
    } else {
      st.graveyard = [{ title: paper.title.slice(0, 70), reason: verdict.reason, at: Date.now() }, ...st.graveyard].slice(0, 200);
      console.log(`✗ graveyard: ${paper.title.slice(0, 50)} — ${verdict.reason}`);
    }
  } catch (e) {
    st.graveyard = [{ title: paper.title.slice(0, 70), reason: `gen: ${e.message.slice(0, 60)}`, at: Date.now() }, ...st.graveyard].slice(0, 200);
    console.log(`✗ generation failed: ${e.message}`);
  }
}
save(st);

// push candidates (accumulating channel) + research summary (merged into state by the paper agent’s next run too)
if (newCandidates.length) {
  const r = await fetch(`${SITE}/api/lab`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, candidates: newCandidates }),
  });
  console.log(`candidates pushed: ${(await r.json()).stored ?? "?"} stored on site`);
}

// merge research stats into lab:state (read-modify-write so paper state stays)
const cur = await (await fetch(`${SITE}/api/lab`, { headers: { "x-lab-token": TOKEN } })).json().catch(() => ({}));
const state = { ...(cur?.state || {}), research: {
  papersRead: st.papersRead,
  attempts: st.attempts,
  graveyard: st.graveyard.length,
  candidates: st.candidates.length,
  lastRun: Date.now(),
  latest: fresh.map((p) => ({ title: p.title.slice(0, 80), link: p.link })),
  lastGraveyard: st.graveyard.slice(0, 3).map((g) => ({ title: g.title, reason: g.reason })),
} };
const push = await fetch(`${SITE}/api/lab`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: TOKEN, state }),
});
console.log(`research run done: read ${fresh.length}, attempts total ${st.attempts}, graveyard ${st.graveyard.length}, candidates ${st.candidates.length} → push ${(await push.json()).ok ? "ok" : "FAILED"}`);
