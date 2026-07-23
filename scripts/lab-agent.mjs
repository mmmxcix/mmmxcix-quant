// lab-agent.mjs v0.2 — the local paper-trading agent (Threepio phase 3).
// Runs on the user's PC (n8n schedules it every 15 min):
//
//   1. fetches the published paper strategies from the site (lab:strategies)
//   2. executes each on fresh market data using the SITE'S OWN engine code
//      (imported straight from ../src/lib — one engine, zero drift)
//   3. keeps virtual positions/equity in a local state file
//   4. pushes the portfolio state back to the site (lab:state → Coach page)
//
// Paper fill model (v1, honest): the current desired position is derived by
// running the real backtest engine over the recent window; when it differs
// from the held virtual position, the change fills at the latest close with
// the strategy's own fee. Positions persist across runs in ~/.mmmxcix-lab.json.
// All money is virtual. Not investment advice.

import { readFileSync, writeFileSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runBacktest, compileStrategy } from "../src/lib/backtest.js";
import { BUILT_IN_STRATEGIES } from "../src/lib/strategies.js";
import { evaluateEntry, drawdownPct, dayLossPct as computeDayLoss } from "../src/lib/riskGate.js";
import { riskRulesFor, PROFILE_IDS, DEFAULT_PROFILE, getProfile } from "../src/lib/profiles.js";
import { currentRegime } from "../src/lib/hmmRegime.js";
import { volTargetWeight } from "../src/lib/volTarget.js";
import { initPy, compilePyStrategy } from "./pyRunnerNode.mjs";
import * as ibkr from "./ibkrPaper.mjs";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
const STATE_FILE = join(homedir(), ".mmmxcix-lab.json");
const START_EQUITY = 10000;
const WARMUP_BARS = 500; // enough for EMA200 + stateful strategies
// How often this 15-min paper run also kicks off ONE research cycle, so the
// research agent needs no separate n8n workflow. Set LAB_AUTO_RESEARCH=0 to opt out.
const RESEARCH_EVERY_MS = +(process.env.LAB_RESEARCH_EVERY_H || 20) * 3600 * 1000;
// Cadence when the site's Always-On switch is ON: research fires every ~30 min
// instead of ~20 h. Safe by construction — the research agent's seen-filter
// makes barren runs cheap, and its paper caps + the windowed DSR accounting
// bound the LLM spend per day.
const ALWAYS_ON_EVERY_MS = +(process.env.LAB_ALWAYS_ON_EVERY_MIN || 30) * 60 * 1000;
// Fixed share count per mirrored stock strategy. Fixed rather than derived from
// the simulator's virtual equity on purpose: the two accounts have different
// balances and will diverge on the first fill, and what is being validated is
// the SIGNAL, not the position sizing.
const IBKR_DEFAULT_SHARES = +(process.env.LAB_IBKR_SHARES || 10);
const YAHOO_INTERVAL = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "60m", "1d": "1d", "1w": "1wk", "1M": "1mo" };
const YAHOO_RANGE = { "1m": "5d", "5m": "1mo", "15m": "1mo", "30m": "3mo", "1h": "3mo", "1d": "2y", "1w": "10y", "1M": "max" };

if (!TOKEN) {
  console.error("LAB_TOKEN is not set. PowerShell: $env:LAB_TOKEN = \"<dev token>\"");
  process.exit(1);
}

// ── data ────────────────────────────────────────────────────────────────────
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
async function fetchStock(symbol, interval) {
  const yi = YAHOO_INTERVAL[interval] || "1d";
  const yr = YAHOO_RANGE[interval] || "2y";
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${yr}&interval=${yi}`,
    { headers: { "user-agent": "Mozilla/5.0" } });
  const r = (await res.json())?.chart?.result?.[0];
  if (!r) throw new Error(`no data for ${symbol}`);
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    out.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return out.slice(-WARMUP_BARS);
}

// ── strategy → current desired position ────────────────────────────────────
function buildSignalFn(s) {
  if (s.mode === "builder") {
    const def = BUILT_IN_STRATEGIES.find((b) => b.id === s.strategyId);
    if (!def) throw new Error(`unknown builder strategy ${s.strategyId}`);
    return def.build(s.params || {});
  }
  // Python strategies (Cortex writes these) go through Pyodide — the same
  // vectorised signals(df) the gauntlet validated, so the paper fill matches the
  // backtest exactly. Requires initPy() to have run (done at startup below).
  return s.language === "python"
    ? compilePyStrategy(s.code || "")
    : compileStrategy(s.code || "");
}

// Run the real engine over the window; if a position was still open on the
// last bar, the engine force-closes it with reason "eod" — that IS the
// strategy's current desired position.
function desiredPosition(s, candles) {
  const res = runBacktest({
    candles, signalFn: buildSignalFn(s),
    initialCapital: 10000, feeBps: s.feeBps ?? 10, positionPct: s.positionPct ?? 100,
  });
  const lastBar = candles[candles.length - 1];
  const t = res.trades[res.trades.length - 1];
  if (t && t.reason === "eod" && t.exitTime === lastBar.time) return t.side;
  return "flat";
}

// ── virtual portfolio accounting (same math as the engine) ─────────────────
function loadLocal() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { strategies: {}, combinedHistory: [] }; }
}
function saveLocal(st) {
  try { writeFileSync(STATE_FILE, JSON.stringify(st)); } catch (e) { console.error("state save failed:", e.message); }
}

function applyTarget(ps, target, price, feeBps, positionPct) {
  const fee = (feeBps ?? 10) / 10000;
  const posFrac = Math.min(100, Math.max(1, positionPct ?? 100)) / 100;
  const mtm = () => (ps.position === "flat"
    ? ps.equity
    : ps.equityAfterEntry + (ps.position === "long" ? 1 : -1) * ps.units * (price - ps.entryPrice));

  let trade = null;
  if (ps.position !== "flat" && target !== ps.position) {
    const gross = mtm();
    const exitFee = ps.units * price * fee;
    const finalEq = gross - exitFee;
    trade = {
      side: ps.position, entryPrice: ps.entryPrice, exitPrice: price,
      pnl: +(finalEq - ps.entryEquity).toFixed(2),
      pnlPct: ps.entryEquity > 0 ? +(((finalEq - ps.entryEquity) / ps.entryEquity) * 100).toFixed(2) : 0,
      closedAt: Date.now(),
    };
    ps.equity = finalEq;
    ps.position = "flat";
    ps.units = 0;
  }
  if (target !== "flat" && ps.position === "flat") {
    const committed = ps.equity * posFrac;
    ps.entryEquity = ps.equity;
    ps.equityAfterEntry = ps.equity - committed * fee;
    ps.units = price > 0 ? (committed * (1 - fee)) / price : 0;
    ps.entryPrice = price;
    ps.position = target;
    ps.openedAt = Date.now();
  }
  ps.markEquity = +mtm().toFixed(2);
  return trade;
}

// ── incubation & divergence (the Phase-5 gatekeeper) ────────────────────────
// A promoted strategy is a HYPOTHESIS until live paper data confirms it.
// Verdicts: incubating (<14d) → watch → confirmed (≥28d, behaving) or
// diverged: live behaviour broke the backtest expectation → quarantined
// (flattened, no fresh entries) until it's re-published. Sticky on purpose —
// a strategy that blew its drawdown budget doesn't earn trust back by
// drifting up afterwards.
const DAY_MS = 86400_000;
function assessIncubation(ps, s) {
  const hist = ps.history || [];
  if (hist.length < 2) return { verdict: "incubating", reason: "collecting data", days: 0 };
  const days = (Date.now() - (ps.incubStart || hist[0].t)) / DAY_MS;
  // Daily closes from the run-level snapshots (last value per UTC day).
  const byDay = new Map();
  for (const p of hist) byDay.set(new Date(p.t).toISOString().slice(0, 10), p.v);
  const closes = [...byDay.values()];
  const liveRetPct = (ps.markEquity / START_EQUITY - 1) * 100;
  let peak = -Infinity, maxDd = 0;
  for (const v of closes) { peak = Math.max(peak, v); if (peak > 0) maxDd = Math.max(maxDd, ((peak - v) / peak) * 100); }
  const rets = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 2 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const tStat = sd > 0 ? mean / (sd / Math.sqrt(rets.length)) : 0;

  // Drawdown budget: 1.5× the backtest's max drawdown (min +5pp headroom);
  // 25% hard fallback when an older promotion carries no expectation.
  const expDd = s.expect?.ddPct ?? null;
  const ddLimit = expDd != null ? Math.max(expDd * 1.5, expDd + 5) : 25;

  let verdict = "incubating";
  let reason = `${Math.floor(days)}d live`;
  if (maxDd > ddLimit) {
    verdict = "diverged";
    reason = `live dd ${maxDd.toFixed(1)}% > budget ${ddLimit.toFixed(1)}% (backtest ${expDd != null ? expDd + "%" : "n/a"})`;
  } else if (days >= 28 && rets.length >= 15 && tStat < -1) {
    verdict = "diverged";
    reason = `losing with confidence (t=${tStat.toFixed(1)}) after ${Math.floor(days)}d`;
  } else if (days >= 28) {
    verdict = liveRetPct > 0 ? "confirmed" : "watch";
    reason = liveRetPct > 0 ? `${Math.floor(days)}d live · +${liveRetPct.toFixed(1)}%` : `flat/negative after ${Math.floor(days)}d`;
  } else if (days >= 14) {
    verdict = "watch";
  }
  if (verdict === "diverged") ps.verdictDiverged = reason;
  if (ps.verdictDiverged) { verdict = "diverged"; reason = ps.verdictDiverged; }
  return {
    verdict, reason, days: +days.toFixed(1),
    liveRetPct: +liveRetPct.toFixed(2), liveDdPct: +maxDd.toFixed(1),
    expRetPct: s.expect?.retPct ?? null, expDdPct: expDd, trades: ps.tradeTotal || 0,
  };
}

// ── main ────────────────────────────────────────────────────────────────────
const stratRes = await fetch(`${SITE}/api/lab?what=strategies`, { headers: { "x-lab-token": TOKEN } });
const stratOut = await stratRes.json().catch(() => ({}));
if (!stratRes.ok) { console.error("strategy fetch failed:", stratRes.status, stratOut); process.exit(1); }
const published = stratOut.strategies?.items || [];

// The site's Always-On switch (Cortex tab bar). Read every cycle so a flip in
// the UI takes effect within ~15 min. Offline/unset → night cadence.
let cortexMode = null;
try {
  const mr = await fetch(`${SITE}/api/lab?what=mode`, { headers: { "x-lab-token": TOKEN } });
  cortexMode = (await mr.json().catch(() => ({})))?.mode || null;
} catch { /* offline → night cadence */ }

// Boot Python once if any published strategy is Python — buildSignalFn() below
// then compiles them synchronously through this one Pyodide instance.
if (published.some((s) => s.language === "python")) {
  const t = Date.now();
  await initPy((m) => console.log(`  ${m}`));
  console.log(`Python runtime ready in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

const local = loadLocal();
const summaries = [];
let note = published.length === 0 ? "no strategies published — bury or promote some in the Registry" : "";

// ── RiskGate: every new entry passes through here; it fails closed ───────────
//
// Two books now, not one. A prop-profile strategy is judged against prop
// limits and the prop book's own drawdown; a private one against private.
// Sharing a single equity curve between them would let a deep private
// drawdown lock the prop book out of trades it is perfectly entitled to take.
const todayKey = Math.floor(Date.now() / 86400000);
if (!local.day || local.day.key !== todayKey) {
  local.day = { key: todayKey, entries: 0, byProfile: {} };
}
if (!local.day.byProfile) local.day.byProfile = {};
if (!local.profileHistory) local.profileHistory = {};

const profileOf = (s) => (PROFILE_IDS.includes(s?.profile) ? s.profile : DEFAULT_PROFILE);
const hourUtc = new Date().getUTCHours();

// Per-profile rule sets and live context. local.riskRules stays supported as a
// per-machine override layered on top of whichever profile applies.
const rulesFor = {};
const gateBase = {};
for (const pid of PROFILE_IDS) {
  rulesFor[pid] = riskRulesFor(pid, local.riskRules || {});
  const hist = local.profileHistory[pid] || [];
  gateBase[pid] = {
    combinedDrawdownPct: drawdownPct(hist),
    dayLossPct: computeDayLoss(hist),
    hourUtc,
  };
}

const countOpenIn = (pid) =>
  published.filter((s) => profileOf(s) === pid)
    .filter((s) => { const p = local.strategies[s.id]; return p && p.position && p.position !== "flat"; })
    .length;
const gateBlocked = [];

// ── IBKR paper mirroring (opt-in) ───────────────────────────────────────────
// Only stock strategies can mirror: the gateway resolves plain US tickers to
// contracts, so a BTCUSDT strategy has nothing to trade there. Crypto entries
// stay simulator-only and say so, rather than failing quietly every run.
let ibkrAccount = null;
const ibkrLog = [];
if (ibkr.TRADING_ENABLED) {
  const st = await ibkr.status();
  if (!st.ok) {
    console.error(`⚠ IBKR gateway unreachable (${st.error}) — simulator only this run`);
    ibkrLog.push({ level: "warn", msg: `gateway unreachable: ${st.error}` });
  } else if (!st.authenticated) {
    console.error("⚠ IBKR gateway is up but not authenticated — log in via the browser once");
    ibkrLog.push({ level: "warn", msg: "gateway not authenticated" });
  } else {
    try {
      ibkrAccount = await ibkr.resolvePaperAccount();
      await ibkr.tickle();
      console.log(`IBKR paper account ${ibkrAccount} armed`);
      ibkrLog.push({ level: "info", msg: `armed on ${ibkrAccount}` });
    } catch (e) {
      // The paper assertion lands here — loud, and trading stays off.
      console.error(`⛔ IBKR disabled: ${e.message}`);
      ibkrLog.push({ level: "error", msg: e.message.slice(0, 160) });
    }
  }
}

for (const s of published) {
  try {
    const candles = s.market === "crypto"
      ? await fetchCrypto(s.symbol, s.interval, WARMUP_BARS)
      : await fetchStock(s.symbol, s.interval);
    if (candles.length < 60) throw new Error("too little data");
    const price = candles[candles.length - 1].close;
    let target = desiredPosition(s, candles);

    const ps = local.strategies[s.id] || { equity: START_EQUITY, position: "flat", units: 0, trades: [] };
    const pid = profileOf(s);

    // Divergence quarantine: a strategy that broke from its backtest
    // expectation is flattened and takes no fresh entries — the paper book
    // must not keep compounding a disproven hypothesis.
    if (ps.verdictDiverged && target !== "flat") {
      if (target !== ps.position) gateBlocked.push({ name: s.name, profile: pid, reason: "quarantined (diverged from backtest)" });
      target = "flat";
    }

    // Current market regime (HMM). Causal here: the candle window ends at "now",
    // so the regime label uses only past+present data — no look-ahead, unlike a
    // backtest. Always reported; only enforced when a strategy opts in.
    let regime = null;
    try { regime = currentRegime(candles, { interval: s.interval }); } catch { /* thin data → no regime */ }

    // Gate any move INTO a position (fresh entry OR flip). Exits pass freely.
    if (target !== "flat" && target !== ps.position) {
      const g = evaluateEntry({ rules: rulesFor[pid], ctx: {
        now: Date.now(), hourUtc, openPositions: countOpenIn(pid),
        combinedDrawdownPct: gateBase[pid].combinedDrawdownPct,
        dayLossPct: gateBase[pid].dayLossPct,
        tradesToday: local.day.byProfile[pid] || 0,
      } });
      if (!g.allow) {
        const reason = g.verdicts.filter((x) => x.status === "block").map((x) => x.rule).join(", ");
        gateBlocked.push({ name: s.name, profile: pid, reason });
        console.log(`⛔ RiskGate[${pid}] blocked ${s.name}: ${reason}`);
        target = "flat"; // fails closed — flatten rather than enter
      }
    }

    // Regime gate (opt-in via s.regimeGate = "Bull" or ["Bull","Neutral"]): only
    // take the entry when the current regime is favourable. A cheap, causal way
    // to make any strategy regime-aware without touching its logic.
    if (target !== "flat" && target !== ps.position && s.regimeGate && regime) {
      const allowed = Array.isArray(s.regimeGate) ? s.regimeGate : [s.regimeGate];
      if (!allowed.includes(regime)) {
        gateBlocked.push({ name: s.name, profile: pid, reason: `regime ${regime}` });
        console.log(`⛔ Regime blocked ${s.name}: ${regime} not in [${allowed.join(", ")}]`);
        target = "flat";
      }
    }

    // GARCH vol-targeting (opt-in via s.volTarget): scale the position inversely
    // to forecast volatility — smaller when the market is violent, full when it
    // is calm. Causal (candles end at "now"). Never leverages above the base
    // size; it can only de-risk, which is the drawdown-cutting behaviour. Set
    // s.volTarget = true, or an object of overrides ({alpha,beta,cap,floor}).
    let volInfo = null;
    let effPositionPct = s.positionPct ?? 100;
    if (s.volTarget) {
      try {
        const w = volTargetWeight(candles, typeof s.volTarget === "object" ? s.volTarget : {});
        effPositionPct = Math.min(100, Math.max(1, Math.round(effPositionPct * w)));
        volInfo = { weight: +w.toFixed(2), sizedPct: effPositionPct };
      } catch { /* thin data → keep base size */ }
    }

    const posBefore = ps.position;
    const trade = applyTarget(ps, target, price, s.feeBps, effPositionPct);
    if (ps.position !== "flat" && ps.position !== posBefore) {
      local.day.entries++;
      local.day.byProfile[pid] = (local.day.byProfile[pid] || 0) + 1;
    }
    if (trade) {
      ps.trades = [...(ps.trades || []), trade].slice(-10);
      ps.tradeTotal = (ps.tradeTotal || 0) + 1;
      console.log(`${s.name}: ${trade.side} closed ${trade.pnlPct}%`);
    }
    // Per-strategy equity history feeds the incubation watchdog (≈48 samples/
    // day at the 30-min cadence; 1500 ≈ a month of context).
    if (!ps.incubStart) ps.incubStart = Date.now();
    ps.history = [...(ps.history || []), { t: Date.now(), v: ps.markEquity }].slice(-1500);
    const incubation = assessIncubation(ps, s);
    if (incubation?.verdict === "diverged" && !ps.divergedLogged) {
      ps.divergedLogged = true;
      console.log(`🧯 QUARANTINED ${s.name}: ${incubation.reason}`);
    }
    local.strategies[s.id] = ps;

    // Mirror the DECISION to the IBKR paper account. Runs after the gate, so a
    // blocked entry is never mirrored — the broker sees the same flat the
    // simulator does.
    let ibkrResult = null;
    if (ibkrAccount) {
      if (s.market !== "stock") {
        ibkrResult = { action: "skip", detail: "not a stock symbol" };
      } else {
        try {
          ibkrResult = await ibkr.syncPosition({
            accountId: ibkrAccount, symbol: s.symbol, target: ps.position,
            shares: s.ibkrShares || IBKR_DEFAULT_SHARES,
          });
          if (ibkrResult.action !== "hold" && ibkrResult.action !== "skip") {
            console.log(`  ⇄ IBKR ${s.symbol}: ${ibkrResult.action} (${ibkrResult.detail})`);
          }
        } catch (e) {
          ibkrResult = { action: "fail", detail: e.message.slice(0, 100) };
          console.error(`  ⇄ IBKR ${s.symbol} failed: ${e.message.slice(0, 90)}`);
        }
      }
    }

    summaries.push({
      id: s.id, name: s.name, symbol: s.symbol, interval: s.interval,
      profile: pid, regime, volTarget: volInfo,
      position: ps.position, equity: ps.markEquity,
      returnPct: +(((ps.markEquity / START_EQUITY) - 1) * 100).toFixed(2),
      tradeCount: (ps.trades || []).length,
      lastTrade: (ps.trades || [])[ps.trades.length - 1] || null,
      price,
      ibkr: ibkrResult,
      incubation,
    });
  } catch (e) {
    summaries.push({ id: s.id, name: s.name, symbol: s.symbol, interval: s.interval, error: e.message });
    console.error(`${s.name}: ${e.message}`);
  }
}

// prune local state for unpublished strategies (keep — they may come back)
const ok = summaries.filter((x) => !x.error);
const combined = ok.reduce((a, x) => a + x.equity, 0);
if (ok.length) {
  local.combinedHistory = [...(local.combinedHistory || []), { t: Date.now(), v: +combined.toFixed(2) }].slice(-200);
  // Each book keeps its own equity curve — that is what the per-profile
  // drawdown limit is measured against on the next run.
  for (const pid of PROFILE_IDS) {
    const inBook = ok.filter((x) => x.profile === pid);
    if (!inBook.length) continue;
    const eq = inBook.reduce((a, x) => a + x.equity, 0);
    local.profileHistory[pid] = [...(local.profileHistory[pid] || []), { t: Date.now(), v: +eq.toFixed(2) }].slice(-200);
  }
}
saveLocal(local);

// The research agent writes state.research into the SAME state object; read
// the current state first so we don't clobber its counters when we push ours.
let priorResearch = null;
try {
  const cur = await (await fetch(`${SITE}/api/lab`, { headers: { "x-lab-token": TOKEN } })).json();
  priorResearch = cur?.state?.research || null;
} catch { /* first run / offline */ }

// One RiskGate report per book, plus a flat top-level view of the default
// profile so older readers of lab:state keep working unchanged.
const byProfile = {};
for (const pid of PROFILE_IDS) {
  const ctx = {
    now: Date.now(), hourUtc, openPositions: countOpenIn(pid),
    combinedDrawdownPct: gateBase[pid].combinedDrawdownPct,
    dayLossPct: gateBase[pid].dayLossPct,
    tradesToday: local.day.byProfile[pid] || 0,
  };
  const blocked = gateBlocked.filter((b) => b.profile === pid);
  byProfile[pid] = {
    armed: true,
    label: getProfile(pid).label,
    rules: rulesFor[pid],
    checkedAt: Date.now(),
    activeLimits: {
      hourUtc,
      openPositions: ctx.openPositions,
      combinedDrawdownPct: +gateBase[pid].combinedDrawdownPct.toFixed(1),
      dayLossPct: +gateBase[pid].dayLossPct.toFixed(1),
      tradesToday: ctx.tradesToday,
    },
    verdicts: evaluateEntry({ rules: rulesFor[pid], ctx }).verdicts,
    blocked: blocked.slice(0, 10),
    blockedCount: blocked.length,
  };
}
const riskgate = {
  ...byProfile[DEFAULT_PROFILE],
  byProfile,
  blocked: gateBlocked.slice(0, 10),
  blockedCount: gateBlocked.length,
  ibkr: ibkr.TRADING_ENABLED
    ? { enabled: true, account: ibkrAccount, log: ibkrLog.slice(0, 5) }
    : { enabled: false },
};

// Incubation rollup: how much of the paper book has reality confirmed?
const incubCounts = { incubating: 0, watch: 0, confirmed: 0, diverged: 0 };
for (const x of summaries) if (x.incubation?.verdict) incubCounts[x.incubation.verdict]++;
if (incubCounts.diverged) note = `${note ? note + " · " : ""}${incubCounts.diverged} strateg${incubCounts.diverged > 1 ? "ies" : "y"} quarantined (diverged from backtest)`;

const state = {
  agent: "lab-agent v0.4",
  mode: published.length ? "paper" : "idle",
  lastRunAt: Date.now(),
  research: priorResearch, // preserve the research loop's stats
  riskgate,
  incubation: incubCounts,
  strategies: summaries,
  combined: summaries.some((x) => !x.error)
    ? {
        equity: +combined.toFixed(2),
        startEquity: summaries.filter((x) => !x.error).length * START_EQUITY,
        returnPct: +(((combined / (summaries.filter((x) => !x.error).length * START_EQUITY)) - 1) * 100).toFixed(2),
        history: local.combinedHistory.slice(-100),
      }
    : null,
  note,
};

const push = await fetch(`${SITE}/api/lab`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: TOKEN, state }),
});
const out = await push.json().catch(() => ({}));
if (!push.ok || !out.ok) { console.error("push failed:", push.status, out); process.exit(1); }
console.log(`paper run complete: ${summaries.length} strategies, combined ${combined ? combined.toFixed(0) : "-"} → pushed ${out.bytes} bytes`);

// ── auto-schedule research (no separate n8n workflow) ───────────────────────
// Night mode: every ~20h this paper run also fires ONE research cycle. With the
// site's Always-On switch ON, the cadence drops to ~30 min — Cortex researches,
// builds and improves around the clock. Spawned DETACHED so it never slows the
// 15-min paper push. Logs: ~/.mmmxcix-research.log.
// LAB_AUTO_RESEARCH=0 disables the NIGHT auto-spawn (when a separate n8n
// research schedule exists) — but the Always-On switch OVERRIDES it: flipping
// the switch in the UI is explicit intent, and without the override the switch
// would silently do nothing on installs that set the kill-switch. Overlap with
// a separate scheduler is prevented by the research agent's own run guard.
{
  try {
    const alwaysOn = !!cortexMode?.alwaysOn;
    const autoEnabled = alwaysOn || process.env.LAB_AUTO_RESEARCH !== "0";
    const everyMs = alwaysOn ? ALWAYS_ON_EVERY_MS : RESEARCH_EVERY_MS;
    const last = local.lastResearchAt || 0;
    if (autoEnabled && Date.now() - last >= everyMs) {
      local.lastResearchAt = Date.now();
      saveLocal(local); // mark BEFORE spawn so a crashing research can't hammer every 15 min
      const researchPath = fileURLToPath(new URL("./research-agent.mjs", import.meta.url));
      const logFd = openSync(join(homedir(), ".mmmxcix-research.log"), "a");
      const child = spawn(process.execPath, [researchPath], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env, // carries LAB_TOKEN
      });
      child.unref();
      console.log(`research due (${alwaysOn ? "always-on, >" + everyMs / 60000 + "min" : ">" + everyMs / 3.6e6 + "h"}) → spawned detached (log: ~/.mmmxcix-research.log)`);
    }
  } catch (e) {
    console.error("research auto-schedule skipped:", e.message);
  }
}
