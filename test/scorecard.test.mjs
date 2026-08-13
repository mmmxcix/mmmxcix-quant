// The setup scorecard: five recorded components, and the guarantee that they are
// recorded rather than applied.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_KEYS, scoreSetup, trendScore, momentumScore, volumeScore, catalystScore, riskScore,
} from "../src/lib/argus/scorecard.js";
import { FEATURES, FEATURES_EXT, SCORE_FEATURES, featuresOf, chooseFeatures, buildDataset } from "../src/lib/argus/metalabel.js";

const inRange = (v, what) => assert.ok(v >= 0 && v <= 10, `${what} out of 0..10: ${v}`);

test("missing evidence scores neutral, never zero", () => {
  assert.equal(trendScore("long", null), 5, "no higher-TF bias");
  assert.equal(momentumScore("long", null), 5, "no momentum reading");
  assert.equal(volumeScore(null), 5, "no rvol");
  assert.equal(catalystScore({}), 5, "no catalyst");
  // A trade with nothing known lands squarely in the middle — an unknown must not
  // read like a bad setup.
  const blank = scoreSetup({ side: "long" });
  for (const k of SCORE_KEYS) assert.equal(blank[k], 5, k);
  assert.equal(blank.total, 50);
});

test("each component moves in the right direction", () => {
  assert.ok(trendScore("long", "up") > trendScore("long", "down"));
  assert.ok(trendScore("short", "down") > trendScore("short", "up"));
  // Momentum is signed INTO the trade direction: the same market move is good for
  // a long and bad for a short.
  assert.ok(momentumScore("long", 2) > 5 && momentumScore("short", 2) < 5);
  assert.equal(+(momentumScore("long", 2) + momentumScore("short", 2)).toFixed(9), 10, "symmetric around neutral");
  assert.ok(volumeScore(2.5) > volumeScore(1) && volumeScore(1) > volumeScore(0.4));
  assert.ok(catalystScore({ evented: true, confidence: 0.8 }) > 5);
  assert.ok(catalystScore({ opposes: true, confidence: 0.6 }) < 5);
  assert.ok(riskScore({ plannedR: 3 }) > riskScore({ plannedR: 1.5 }));
  assert.ok(riskScore({ plannedR: 2, volElevated: true }) < riskScore({ plannedR: 2 }));
  assert.ok(riskScore({ plannedR: 2, heatUsedPct: 11, heatCapPct: 12 }) < riskScore({ plannedR: 2 }));
});

test("components stay inside 0..10 under extreme inputs", () => {
  for (const ctx of [
    { side: "long", bias: "up", momAtr: 50, rvol: 40, evented: true, confidence: 1, plannedR: 20 },
    { side: "short", bias: "up", momAtr: 50, rvol: 0.01, opposes: true, confidence: 1, plannedR: 0.1, volElevated: true, heatUsedPct: 99, heatCapPct: 12 },
    { side: "long", momAtr: -Infinity, rvol: -5, plannedR: NaN, heatCapPct: 0 },
  ]) {
    const s = scoreSetup(ctx);
    for (const k of SCORE_KEYS) inRange(s[k], k);
    assert.ok(s.total >= 0 && s.total <= 100, `total ${s.total}`);
  }
});

test("the total is the plain average — no hidden weighting", () => {
  const s = scoreSetup({ side: "long", bias: "up", momAtr: 1.2, rvol: 1.8, evented: true, confidence: 0.5, plannedR: 2.4 });
  const mean = SCORE_KEYS.reduce((a, k) => a + s[k], 0) / SCORE_KEYS.length;
  assert.equal(s.total, Math.round(10 * mean));
});

// ── the record, not the decision ────────────────────────────────────────────
const trade = (over = {}) => ({
  state: "closed", side: "long", entry: 100, stop: 98, plannedR: 2, leverage: 3,
  openedAt: Date.UTC(2026, 7, 13, 9), exitAt: Date.UTC(2026, 7, 13, 11), outcome: "target",
  riskChecks: { volatility: { label: "0.17%/bar" }, volume: { rvol: 1.4 }, heatUsedPct: 6 },
  ...over,
});

test("scores widen the feature row only when asked", () => {
  const withScores = trade({ scores: scoreSetup({ side: "long", bias: "up", momAtr: 1, rvol: 1.4, plannedR: 2 }) });
  assert.equal(featuresOf(withScores).length, FEATURES.length, "base set unchanged");
  assert.equal(featuresOf(withScores, FEATURES_EXT).length, FEATURES_EXT.length);
  // A trade from before the scorecard cannot be described by the wider set, and
  // says so instead of substituting zeros.
  assert.equal(featuresOf(trade(), FEATURES_EXT), null);
  assert.equal(featuresOf(trade()).length, FEATURES.length, "…but is still usable in the base set");
  assert.equal(SCORE_FEATURES.length, SCORE_KEYS.length);
});

test("the wider feature set waits for the sample that can carry it", () => {
  const scored = (outcome) => trade({ outcome, scores: scoreSetup({ side: "long", bias: "up", momAtr: 1, rvol: 1.4, plannedR: 2 }) });
  // 40 winners / 40 losers: enough for the base set (10 features × 10), not for
  // the extended one (15 × 10) — so the study must not quietly widen itself.
  const ledger = [...Array(40)].map(() => scored("target")).concat([...Array(40)].map(() => scored("stop")));
  assert.equal(chooseFeatures(ledger), FEATURES);
  // 150 of the rarer class clears the wider bar.
  const big = [...Array(150)].map(() => scored("target")).concat([...Array(150)].map(() => scored("stop")));
  assert.equal(chooseFeatures(big), FEATURES_EXT);
  assert.equal(buildDataset(big, FEATURES_EXT).X[0].length, FEATURES_EXT.length);
});
