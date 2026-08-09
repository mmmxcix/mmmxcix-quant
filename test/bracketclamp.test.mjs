import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../src/lib/backtest.js";
import { auditStrategy } from "../src/lib/strategyAudit.js";

// The screenshot bug (Aug 2026): a long whose stop sat ABOVE entry (sign bug /
// optimizer-driven negative riskMultiplier) exited EVERY trade at a fantasy
// price above the market — 100% win rate, 0% drawdown, 10^150 equity. Brackets
// must never fill at a price the market didn't offer from the bar's open on.

const bar = (t, o, h, l, c) => ({ time: t * 3600, open: o, high: h, low: l, close: c, volume: 1 });

test("inverted long stop (above entry) fills at the OPEN — no free profits", () => {
  // Flat market at 100. Strategy places its long stop 2% ABOVE the market.
  const candles = Array.from({ length: 30 }, (_, i) => bar(i, 100, 100, 100, 100));
  const r = runBacktest({
    candles,
    signalFn: (ctx) => (ctx.position === "flat" ? { signal: "long", stop: ctx.close * 1.02 } : "flat"),
    feeBps: 10,
  });
  assert.ok(r.trades.length >= 20, `expected many churned trades, got ${r.trades.length}`);
  // Every fill clamps to the open (=entry) → each round trip loses the fees.
  for (const t of r.trades) {
    assert.equal(t.exitPrice, 100);
    assert.ok(t.pnl < 0, `trade must lose its fees, got pnl ${t.pnl}`);
  }
  assert.equal(r.metrics.winRatePct, 0);
  assert.ok(r.warnings.some((w) => w.includes("Bracket sanity")), "expected the bracket-sanity warning");
});

test("a normal stop below entry still fills exactly at the stop", () => {
  const candles = [
    bar(0, 100, 100, 100, 100),
    bar(1, 100, 101, 96, 100), // stop 95 not touched
    bar(2, 100, 100, 94, 99),  // low 94 → stop 95 fills AT 95 (open was 100)
    bar(3, 99, 99, 99, 99),
  ];
  let entered = false;
  const r = runBacktest({
    candles,
    signalFn: (ctx) => {
      if (ctx.position === "flat" && !entered) { entered = true; return { signal: "long", stop: 95 }; }
      return ctx.position === "flat" ? "flat" : { signal: "long", stop: 95 };
    },
    feeBps: 0,
  });
  const stopTrade = r.trades.find((t) => t.reason === "stop");
  assert.ok(stopTrade, "expected a stop exit");
  assert.equal(stopTrade.exitPrice, 95);
});

test("a gap THROUGH the stop fills at the open, not at the stop", () => {
  const candles = [
    bar(0, 100, 100, 100, 100),
    bar(1, 100, 101, 98, 100),
    bar(2, 90, 91, 88, 89),   // gaps down through the 95 stop → real fill = open 90
    bar(3, 89, 89, 89, 89),
  ];
  let entered = false;
  const r = runBacktest({
    candles,
    signalFn: (ctx) => {
      if (ctx.position === "flat" && !entered) { entered = true; return { signal: "long", stop: 95 }; }
      return ctx.position === "flat" ? "flat" : { signal: "long", stop: 95 };
    },
    feeBps: 0,
  });
  const stopTrade = r.trades.find((t) => t.reason === "stop");
  assert.ok(stopTrade, "expected a stop exit");
  assert.equal(stopTrade.exitPrice, 90);
});

test("a gap beyond the target fills at the (better) open — the market price", () => {
  const candles = [
    bar(0, 100, 100, 100, 100),
    bar(1, 100, 102, 100, 101),
    bar(2, 115, 116, 114, 115), // opens above the 110 target → limit fills at 115
    bar(3, 115, 115, 115, 115),
  ];
  let entered = false;
  const r = runBacktest({
    candles,
    signalFn: (ctx) => {
      if (ctx.position === "flat" && !entered) { entered = true; return { signal: "long", target: 110 }; }
      return ctx.position === "flat" ? "flat" : { signal: "long", target: 110 };
    },
    feeBps: 0,
  });
  const tgtTrade = r.trades.find((t) => t.reason === "target");
  assert.ok(tgtTrade, "expected a target exit");
  assert.equal(tgtTrade.exitPrice, 115);
});

test("a flawless run over 20+ trades raises the implausible-result warning", () => {
  // Monotonic +2% bars; each trade takes a legitimate +1% target — all winners.
  const candles = [];
  let p = 100;
  for (let i = 0; i < 30; i++) { candles.push(bar(i, p, p * 1.02, p, p * 1.02)); p *= 1.02; }
  const r = runBacktest({
    candles,
    signalFn: (ctx) => (ctx.position === "flat" ? { signal: "long", target: ctx.close * 1.01 } : "flat"),
    feeBps: 1,
  });
  assert.ok(r.trades.length >= 20);
  assert.equal(r.metrics.winRatePct, 100);
  assert.ok(r.warnings.some((w) => w.includes("Implausible result")), "expected the implausible-result warning");
});

// ── Audit rules that catch this class statically ────────────────────────────

test("audit flags a long-only strategy whose stop is computed ABOVE entry", () => {
  const code = `function strategy(ctx) {
    if (ctx.position === "flat") {
      const stop = ctx.close + ctx.indicators.atr(ctx.candles, 14)[ctx.index] * 2;
      return { signal: "long", stop, target: ctx.close * 1.05 };
    }
    return "flat";
  }`;
  const a = auditStrategy(code, "js");
  assert.ok(a.findings.some((f) => f.id === "inverted-long-bracket"));
  assert.ok(a.blocked);
});

test("audit does NOT flag a correct dual-side strategy (both stop signs present)", () => {
  const code = `function strategy(ctx) {
    const atr = ctx.indicators.atr(ctx.candles, 14)[ctx.index];
    if (ctx.close > 100) { const stop = ctx.close - atr * 2; return { signal: "long", stop }; }
    const stop = ctx.close + atr * 2; return { signal: "short", stop };
  }`;
  assert.equal(auditStrategy(code, "js").findings.some((f) => f.id === "inverted-long-bracket"), false);
  assert.equal(auditStrategy(code, "js").findings.some((f) => f.id === "inverted-short-bracket"), false);
});

test("audit catches the impossible self-inclusive rolling-min exit (dead exit)", () => {
  // The real pattern from "Bitcoin-Google" / "EMA trend (long)": the exit level
  // includes the current close, so close < exit_level can never be true.
  const broken = `def signals(df):
    df['exit_level'] = df['close'].rolling(10).min()
    exit_condition = df['close'] < df['exit_level']
    return exit_condition`;
  const a = auditStrategy(broken, "python");
  assert.ok(a.findings.some((f) => f.id === "self-inclusive-extreme-exit"));
  assert.ok(a.blocked);
  // The corrected form (shifted window) must NOT fire.
  const fixed = `def signals(df):
    df['exit_level'] = df['close'].rolling(10).min().shift(1)
    exit_condition = df['close'] < df['exit_level']
    return exit_condition`;
  assert.equal(auditStrategy(fixed, "python").findings.some((f) => f.id === "self-inclusive-extreme-exit"), false);
  // A low-based level is fine too (low can be under the close).
  const lowBased = `def signals(df):
    df['exit_level'] = df['low'].rolling(10).min()
    exit_condition = df['close'] < df['exit_level']
    return exit_condition`;
  assert.equal(auditStrategy(lowBased, "python").findings.some((f) => f.id === "self-inclusive-extreme-exit"), false);
});

test("audit warns on a stop/target anchored to the previous bar, not the entry", () => {
  // The real pattern from "DAX30 -LONG SET UP": a one-bar move is not a bracket.
  const code = `def signals(df):
    if (df['close'].iloc[i] - df['close'].iloc[i-1]) / df['close'].iloc[i-1] <= -stop_loss:
        signals.iloc[i] = 0`;
  const a = auditStrategy(code, "python");
  assert.ok(a.findings.some((f) => f.id === "prev-bar-anchored-bracket"));
});

test("audit warns on hardcoded price levels but not indicator thresholds", () => {
  const hard = `function strategy(ctx){ return ctx.close > 4270 && ctx.close < 4330 ? "long" : "flat"; }`;
  assert.ok(auditStrategy(hard, "js").findings.some((f) => f.id === "hardcoded-price-level"));
  const rsiOnly = `function strategy(ctx){ const r = ctx.indicators.rsi(ctx.indicators.closes(ctx.candles), 14)[ctx.index]; return r > 70 ? "short" : "flat"; }`;
  assert.equal(auditStrategy(rsiOnly, "js").findings.some((f) => f.id === "hardcoded-price-level"), false);
});
