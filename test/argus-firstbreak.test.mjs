// Regression tests for the Aug 19/20 Argus overhaul: first-break invalidation,
// bar-replay exit fidelity, the leverage/liquidation buffer, ledger-integrity
// pass-through, rule-(a) probeability, mode-aware invalPolicy and the
// confirm-rule shadow. Pure logic, run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openThesis, evaluateExit, chooseLeverage, liquidationPrice } from "../src/lib/argus/core.js";
import { adjustment } from "../src/lib/argus/learn.js";
import { invalPolicy, confirmRuleShadow } from "../src/lib/argus/review.js";
import { scan } from "../src/lib/argus/scanners.js";

const bar = (o, h, l, c, v = 1000, t = 0) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });
const flat = (n, mid, wick = 0.3) => Array.from({ length: n }, (_, i) => bar(mid, mid + wick, mid - wick, mid, 1000, i));

/** A long crypto thesis with an invalidation level between entry and stop. */
function longThesis() {
  const th = openThesis(
    { symbol: "T", market: "crypto", side: "long", kind: "breakout", timeframe: "5m",
      entry: 100, stop: 98, target: 104, invalidation: 99.2, reason: "test" },
    { equity: 10000, openRisk: 0, asset: "crypto", heatCap: 0.1, baseRiskPct: 0.0035, maxTradeLev: 25, portfolioLevCap: 50, conviction: 0.6 },
  );
  assert.ok(th, "fixture thesis opens");
  return th;
}

test("firstbreak: the invalidation exits on the FIRST qualifying close (confirm waits, and demands 0.80)", () => {
  // close 98.8 — beyond the 99.2 level by more than 0.15×risk, adverse ≈0.61R ≥ 0.60.
  const armBar = (t) => bar(99.1, 99.2, 98.5, 98.8, 1000, t);
  const a = longThesis();
  const r1 = evaluateExit(a, armBar(100), { invalMode: "firstbreak" });
  assert.ok(r1 && r1.outcome === "invalidated", "firstbreak exits on the arming bar itself");
  // The SAME bar does not even ARM confirm mode (0.61R < its 0.80 threshold)…
  const b = longThesis();
  assert.equal(evaluateExit(b, armBar(100), { invalMode: "confirm" }), null, "0.61R adverse does not arm confirm mode");
  assert.equal(b.invalBrokeCount || 0, 0, "confirm mode saw nothing to count");
  // …and at a depth that does arm it (adverse ≈0.81R), confirm still waits for bar 2.
  const deepBar = (t) => bar(98.9, 99.0, 98.05, 98.4, 1000, t);
  assert.equal(evaluateExit(b, deepBar(100), { invalMode: "confirm" }), null, "confirm mode holds after one armed bar");
  const r2 = evaluateExit(b, deepBar(101), { invalMode: "confirm" });
  assert.ok(r2 && r2.outcome === "invalidated", "confirm mode exits on the second distinct armed bar");
});

test("firstbreak ignores the per-thesis learned overrides (the tuner must not re-loosen it)", () => {
  const th = longThesis();
  th.invalMinAdverse = 0.95;  // learned override that would refuse this exit…
  th.invalConfirmBars = 5;    // …and this delay — both are confirm-mode knobs
  const r = evaluateExit(th, bar(99.1, 99.2, 98.5, 98.8, 1000, 100), { invalMode: "firstbreak" });
  assert.ok(r && r.outcome === "invalidated", "firstbreak fires at its own fixed 0.60 arming, first bar");
});

test("firstbreak still requires the measured 0.60 arming — a 0.5R wobble is left alone", () => {
  const th = longThesis();
  // close 99.03: adverse ≈0.5R, and not beyond the level by the buffer either.
  const r = evaluateExit(th, bar(99.3, 99.4, 98.9, 99.03, 1000, 100), { invalMode: "firstbreak" });
  assert.equal(r, null, "a trade that can still reverse to target is not cut");
});

test("bar-replay contract: a stop wicked on an OLDER bar exits at the stop, not never", () => {
  const th = longThesis();
  const bars = [
    bar(100, 100.5, 99.6, 100.2, 1000, 100),
    bar(100.2, 100.3, 97.5, 99.5, 1000, 101), // wick pierces the 98 stop, closes back above
    bar(99.5, 100.8, 99.4, 100.6, 1000, 102), // by the next poll this is the "latest" bar
  ];
  // The OLD code only ever saw the latest bar — which shows nothing:
  assert.equal(evaluateExit(longThesis(), bars[2], {}), null, "the latest bar alone hides the stop-out");
  // The replay walks every unseen bar in order and finds the stop where it happened:
  let res = null;
  for (const b of bars) { res = evaluateExit(th, b, { now: b.time * 1000 + 300000 }); if (res) break; }
  assert.ok(res && res.outcome === "stop", "replay finds the pierced stop");
  assert.ok(Math.abs(res.exit - 98) < 98 * 0.001, "filled AT the stop level (± exit slippage)");
  assert.equal(res.exitAt, 101 * 1000 + 300000, "stamped when it happened, not when it was noticed");
});

test("leverage keeps liquidation ≥ ~2 stop-distances away, and the situational choice survives", () => {
  for (const stopDist of [0.2, 0.5, 1, 2]) {
    const lev = chooseLeverage(100, stopDist, { conviction: 1, asset: "crypto", rr: 5, maxTradeLev: 100 });
    const liq = liquidationPrice(100, "long", lev);
    if (liq != null) {
      assert.ok(100 - liq >= 2 * stopDist - 1e-9, `liq ${liq.toFixed(2)} sits ≥2 stop-distances (stop ${stopDist})`);
    }
  }
  const strong = chooseLeverage(100, 0.2, { conviction: 0.95, asset: "crypto", rr: 3, maxTradeLev: 25 });
  const weak = chooseLeverage(100, 0.2, { conviction: 0.4, asset: "crypto", maxTradeLev: 25 });
  assert.ok(strong > weak, "conviction still moves the dial under the cap");
  assert.ok(strong <= 25, "user cap binds");
});

test("openThesis persists the whole decision context (the whitelist bug that unlabeled every probe)", () => {
  const th = openThesis(
    { symbol: "T", market: "crypto", side: "long", kind: "breakout", timeframe: "5m",
      entry: 100, stop: 98, target: 104, invalidation: 99.2, reason: "test",
      explore: true, regime: "Bull", conviction: 0.7, atrPct: 0.002, rvol: 1.4, momAtr: 0.5,
      limitFill: false, shadow: { regimeWouldVeto: true, htfWouldVeto: false } },
    { equity: 10000, openRisk: 0, asset: "crypto", heatCap: 0.1, baseRiskPct: 0.0035, maxTradeLev: 25, portfolioLevCap: 50 },
  );
  assert.equal(th.explore, true, "a probe stays labeled a probe on the record");
  assert.equal(th.regime, "Bull", "the HMM regime reaches the ledger (its lesson bucket trained on null before)");
  assert.equal(th.conviction, 0.7);
  assert.equal(th.atrPct, 0.002);
  assert.equal(th.rvol, 1.4);
  assert.equal(th.momAtr, 0.5);
  assert.equal(th.limitFill, false);
  assert.equal(th.shadow.regimeWouldVeto, true, "shadow would-veto flags ride along for the n≥30 review");
  // invalLevelR ≈ |fillEntry − 99.2| / |fillEntry − 98| — where the early exit sits, in R.
  assert.ok(th.invalLevelR > 0.3 && th.invalLevelR < 0.6, `invalLevelR stamped (${th.invalLevelR})`);
  // A normal bet carries NO explore key at all (undefined → absent after JSON).
  const plain = openThesis(
    { symbol: "T", market: "crypto", side: "long", kind: "breakout", timeframe: "5m", entry: 100, stop: 98, target: 104, reason: "t" },
    { equity: 10000, openRisk: 0, asset: "crypto", heatCap: 0.1, baseRiskPct: 0.0035 },
  );
  assert.equal(JSON.parse(JSON.stringify(plain)).explore, undefined, "chosen bets stay unmarked");
});

test("rule-(a) skips are probeable: weakestSkip is set, so explore.js can rescue the bucket", () => {
  const lesson = {
    dims: { kind: "orb", symbol: "XUSDT" }, action: "suppress",
    expectancy: -0.9, winRate: 0.1, n: 25, tStat: -1.5, bookShare: 0.2, avgR: -0.9,
    text: "orb on XUSDT: broken",
  };
  const a = adjustment([lesson], { kind: "orb", symbol: "XUSDT" }, { minSample: 20 });
  assert.equal(a.skip, true, "the egregious specific bucket is refused");
  assert.ok(a.weakestSkip, "…but names its weakest lesson, so the refusal is not permanent by construction");
  assert.equal(a.weakestSkip.dims.kind, "orb");
});

test("invalPolicy is mode-aware: firstbreak keeps only the raised-bar escape hatch", () => {
  // Confirm mode: a justified-heavy tally still tightens (the old behaviour).
  assert.equal(invalPolicy({ justified: 4, premature: 0 }).label, "cut-earlier");
  // Firstbreak: the tuning tiers are no-ops — nothing to tune, nothing to re-loosen.
  assert.deepEqual(invalPolicy({ justified: 10, premature: 0 }, "firstbreak"), {});
  assert.deepEqual(invalPolicy({ premature: 3, justified: 0 }, "firstbreak"), {}, "old disable bar (3) no longer trips");
  // …except the escape hatch, at premature ≥5 AND > 2× justified.
  assert.equal(invalPolicy({ premature: 5, justified: 2 }, "firstbreak").disable, true);
  assert.deepEqual(invalPolicy({ premature: 5, justified: 3 }, "firstbreak"), {}, "5 vs 3 does not clear the 2× bar");
});

test("confirmRuleShadow replays where the OLD confirm rule would have exited", () => {
  const rec = { side: "long", entry: 100, stop: 98, target: 104, invalidation: 99.2 };
  // Next bar still broke → the old rule confirms and exits at that close.
  const confirmed = confirmRuleShadow(rec, [bar(98.8, 99.0, 98.5, 98.7, 1000, 1)]);
  assert.equal(confirmed.how, "confirm");
  assert.ok(Math.abs(confirmed.shadowR - (98.7 - 100) / 2) < 1e-9, "close-basis R at the confirm bar");
  // Stop hit while "confirming" → the old rule ate the full stop.
  const stopped = confirmRuleShadow(rec, [bar(98.8, 98.9, 97.9, 98.4, 1000, 1)]);
  assert.equal(stopped.how, "stop");
  assert.equal(stopped.shadowR, -1);
  // Reclaim then target → the old rule's hold would have WON (the firstbreak cut cost this one).
  const won = confirmRuleShadow(rec, [bar(99.4, 99.6, 99.3, 99.5, 1000, 1), bar(99.5, 104.2, 99.4, 104.0, 1000, 2)]);
  assert.equal(won.how, "target");
  assert.equal(won.shadowR, 2);
});

test("scan honours the kind allowlist (retired scanners emit nothing, not even forming)", () => {
  const c5 = [...flat(60, 100), bar(100, 102, 100, 101.8, 3000, 61)]; // clean 20-bar breakout
  const c1h = flat(40, 100);
  const all = scan({ c5, c1h });
  assert.ok(all.triggered.some((s) => s.kind === "breakout"), "fixture triggers a breakout unrestricted");
  const gated = scan({ c5, c1h }, { kinds: new Set(["mean-reversion"]) });
  assert.ok(!gated.triggered.some((s) => s.kind === "breakout"), "a retired kind cannot trigger");
  assert.ok(!gated.forming.some((s) => s.kind === "breakout"), "…and cannot park a forming setup either");
});
