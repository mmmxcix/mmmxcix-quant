// retest-library.mjs — Cortex's auto-progression pass over the strategy library.
//
// Reads the shared D1 library (/api/library, machine-token auth), first ADOPTS
// any live paper-book strategy that has no library card yet (so the pass always
// covers ALL lab-agent strategies, even if no browser opened the Registry), then
// re-runs each non-buried strategy through:
//
//   1. the CODE audit (strategyAudit.js) — a critical logic bug (look-ahead,
//      degenerate arbitrage, constant signal, inverted short bracket) means the
//      backtest is a lie. The strategy is sidelined to "improve" with the bug
//      named; if it's still buggy after AUDIT_GRACE_DAYS it's buried for good.
//   2. a fresh backtest + progression.js — advance up the pipeline, sideline to
//      "improve" on a fixable flaw, or bury on a failed re-test.
//
// A burial removes the strategy EVERYWHERE: library stage → graveyard (14-day
// rescue window, then deleted server-side below) AND retired from the live
// paper book (/api/lab retire), so the agent stops trading it next cycle.
// Scheduled by agent-daemon.mjs. Publishing to the live agent stays manual.

import { runBacktest, compileStrategy } from "../src/lib/backtest.js";
import { compilePyStrategy, initPy } from "./pyRunnerNode.mjs";
import { BUILT_IN_STRATEGIES } from "../src/lib/strategies.js";
import { windowProfile } from "../src/lib/windowProfile.js";
import { progressEntry } from "../src/lib/progression.js";
import { auditStrategy } from "../src/lib/strategyAudit.js";
import { GRAVEYARD_TTL_DAYS } from "../src/lib/registry.js";
import { loadMarket } from "./marketdata.mjs";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
const DAY_MS = 86_400_000;

// Quality bar for advancement — tunable via env, defaults matching the research
// agent's "a quant would find this attractive" standard. minTrades 100 per the
// Aug 2026 sample-size calibration (30 was only the CLT floor — below ~100
// trades a lucky streak looks like an edge); the Sharpe bar tiers up on thin
// samples inside progressEntry (≥1.2 under 150 trades, ≥1.0 under 300).
const BAR = {
  minSharpe: +(process.env.LAB_LIB_MIN_SHARPE || 0.8),
  minPF: +(process.env.LAB_LIB_MIN_PF || 1.15),
  minTrades: +(process.env.LAB_LIB_MIN_TRADES || 100),
};

// How long a critical-code-bug strategy may sit in "improve" awaiting a fix
// before it's declared unfixable and buried. Two retest passes run per day, so
// 3 days ≈ 6 chances for a fix (Cortex improve loop or a manual edit) to land.
const AUDIT_GRACE_DAYS = +(process.env.LAB_AUDIT_GRACE_DAYS || 3);

async function postLibrary(body) {
  await fetch(`${SITE}/api/library`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, ...body }),
  });
}

// Remove a buried strategy from the LIVE paper book too, by every identity we
// know for it — its library id, the lab-book id it was adopted from, its Cortex
// candidate id, and its code (catches republished copies under other ids).
async function retireFromAgent(entry) {
  const ids = [entry.id, entry.paperId, entry.candidateId].filter(Boolean);
  const codes = entry.code ? [entry.code] : [];
  if (!ids.length && !codes.length) return;
  try {
    await fetch(`${SITE}/api/lab`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, retire: { ids, codes } }),
    });
  } catch { /* offline — tidyStrategies still drops critical-bug strats server-side */ }
}

/** Rebuild a runnable signal function from a stored entry (builder or code). */
function signalFor(entry) {
  if (entry.mode === "builder" && entry.strategyId) {
    const s = BUILT_IN_STRATEGIES.find((x) => x.id === entry.strategyId);
    return s ? s.build(entry.params || {}) : null;
  }
  if (entry.code) return entry.language === "python" ? compilePyStrategy(entry.code) : compileStrategy(entry.code);
  return null;
}

/** Load candles for the market/window the entry was defined on. */
async function candlesFor(entry) {
  const asset = entry.market === "crypto" ? "crypto" : "stock";
  const ds = await loadMarket({ id: entry.symbol, asset, symbol: entry.symbol, interval: entry.interval || "1d", range: entry.range || "5y", bars: 6000 });
  return ds?.candles || null;
}

// Adopt every live paper-book strategy that has no library card yet — the same
// reconciliation the Registry page does when open, done here too so the
// twice-daily retest ALWAYS sees the whole lab book. Returns the new entries.
async function adoptUncardedPaperStrategies(entries) {
  let paperItems = [];
  try {
    const out = await (await fetch(`${SITE}/api/lab?what=strategies`, { headers: { "x-lab-token": TOKEN } })).json();
    paperItems = out?.strategies?.items || [];
  } catch { return []; }
  const havePaperId = new Set(entries.filter((e) => e.paperId).map((e) => e.paperId));
  const haveCode = new Set(entries.filter((e) => e.code).map((e) => e.code));
  const haveCand = new Set(entries.filter((e) => e.candidateId).map((e) => e.candidateId));
  const adopted = [];
  for (const s of paperItems) {
    if (!s || !s.id || !s.code) continue;
    if (havePaperId.has(s.id) || haveCode.has(s.code)) continue;
    if (s.candidateId && haveCand.has(s.candidateId)) continue;
    const entry = {
      id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(), statusAt: Date.now(),
      name: s.name || "Paper strategy", market: s.market, symbol: s.symbol, interval: s.interval,
      range: null, mode: "code", strategyId: null, params: null,
      code: s.code, language: s.language || null,
      positionPct: s.positionPct ?? 100, feeBps: s.feeBps ?? 10, leverage: s.leverage ?? 1,
      metrics: null, validation: null, returnSeries: [], tradeCount: 0,
      status: "paper", everLive: true, paperId: s.id, candidateId: s.candidateId || null,
      failureReason: "Adopted from the live paper book by the retest pass.", note: "",
    };
    adopted.push(entry);
    await postLibrary({ upsert: entry });
  }
  return adopted;
}

export async function retestLibrary() {
  if (!TOKEN) { console.error("LAB_TOKEN is not set."); return []; }
  let entries = [];
  try {
    const r = await fetch(`${SITE}/api/library`, { headers: { "x-lab-token": TOKEN } });
    const j = await r.json();
    entries = Array.isArray(j.entries) ? j.entries : [];
  } catch (e) { console.error(`[${new Date().toISOString()}] library fetch failed: ${e.message}`); return []; }

  const adopted = await adoptUncardedPaperStrategies(entries);
  if (adopted.length) entries = [...entries, ...adopted];
  if (!entries.length) { console.log(`[${new Date().toISOString()}] library empty — nothing to re-test`); return []; }

  if (entries.some((e) => e.language === "python")) { try { await initPy(); } catch { /* JS-only fallback */ } }

  const moves = [];
  const bury = async (entry, failureReason, why) => {
    entry.status = "graveyard";
    entry.statusAt = Date.now(); // the 14-day rescue countdown starts NOW
    entry.failureReason = failureReason;
    moves.push({ name: entry.name, to: "graveyard", why });
    await postLibrary({ upsert: entry });
    await retireFromAgent(entry); // …and out of the live paper book
  };

  for (const entry of entries) {
    if (entry.status === "graveyard") continue; // leave the dead buried
    try {
      // ── 1) CODE AUDIT — a critical logic bug means every backtest number is
      // an artifact, so this runs BEFORE the backtest and blocks progression.
      if (entry.code) {
        const audit = auditStrategy(entry.code, entry.language === "python" ? "python" : "js");
        if (audit.blocked) {
          const crit = audit.findings.filter((f) => f.severity === "critical");
          const bugIds = crit.map((f) => f.id).join(", ");
          const flaggedAt = entry.auditFlaggedAt || 0;
          if (flaggedAt && Date.now() - flaggedAt >= AUDIT_GRACE_DAYS * DAY_MS) {
            // Still buggy after the grace window → unfixable, bury + retire.
            await bury(entry,
              `Buried — critical code bug unfixed after ${AUDIT_GRACE_DAYS} days (${bugIds}). ${crit[0]?.msg || ""}`,
              "unfixed code bug");
          } else if (!flaggedAt || entry.status !== "improve") {
            // First detection → sideline to "improve" with the bug named, so the
            // improve loop (or a human) can fix it before the clock runs out.
            entry.status = "improve";
            entry.statusAt = Date.now();
            entry.auditFlaggedAt = flaggedAt || Date.now();
            entry.failureReason = `Critical code bug (${bugIds}) — the backtest can't be trusted: ${crit[0]?.msg || ""}`;
            moves.push({ name: entry.name, to: "improve", why: "code audit" });
            await postLibrary({ upsert: entry });
          }
          continue; // never advance a lying backtest
        }
        if (entry.auditFlaggedAt) entry.auditFlaggedAt = null; // fixed → clean slate
      }

      // ── 2) FRESH BACKTEST + progression ─────────────────────────────────
      const fn = signalFor(entry);
      if (!fn) continue;
      const candles = await candlesFor(entry);
      if (!candles) continue;
      const res = runBacktest({ candles, signalFn: fn, initialCapital: 10000, feeBps: entry.feeBps ?? 10, positionPct: entry.positionPct ?? 100, leverage: entry.leverage ?? 1 });
      const retest = { metrics: res.metrics, windowProfile: windowProfile(res.equity, { segments: 2 }) };
      const d = progressEntry(entry, retest, BAR);
      // Always refresh the stored metrics/profile so the Registry shows reality.
      entry.metrics = res.metrics;
      entry.windowProfile = retest.windowProfile;
      if (d.changed && d.status === "graveyard") {
        await bury(entry, d.failureReason, d.reason);
        continue;
      }
      entry.status = d.status;
      entry.failureReason = d.failureReason;
      if (d.changed) {
        entry.statusAt = Date.now();
        moves.push({ name: entry.name, to: d.status, why: d.reason });
      }
      await postLibrary({ upsert: entry });
    } catch (e) { console.error(`  ${(entry.name || entry.id || "?").slice(0, 40)}: ${String(e.message).slice(0, 80)}`); }
  }

  // ── 3) GRAVEYARD TTL, server-side — the Registry page prunes on mount, but
  // that only happens when a browser visits. Enforce the 14-day retention here
  // too, so a buried strategy is permanently deleted on schedule regardless.
  let purged = 0;
  const now = Date.now();
  for (const e of entries) {
    if (e.status !== "graveyard") continue;
    if (now - (e.statusAt || e.createdAt || now) >= GRAVEYARD_TTL_DAYS * DAY_MS) {
      await postLibrary({ remove: e.id });
      purged++;
    }
  }

  console.log(`[${new Date().toISOString()}] retest: ${entries.length} entries (${adopted.length} adopted) · ${moves.length} moved${moves.length ? " — " + moves.map((m) => `${m.name}→${m.to}(${m.why})`).join(", ") : ""}${purged ? ` · ${purged} expired from the graveyard` : ""}`);
  return moves;
}

// The daemon fork()s this file as the entry point → run the pass and exit.
if (process.argv[1] && /retest-library\.mjs$/.test(process.argv[1].replace(/\\/g, "/"))) {
  retestLibrary().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
