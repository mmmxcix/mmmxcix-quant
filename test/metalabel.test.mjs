import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURES, featuresOf, labelOf, buildDataset, purgedFolds,
  fitLogistic, auc, metaLabelStudy, EVENTS_PER_FEATURE,
} from "../src/lib/argus/metalabel.js";

// A meta-label gate is only as trustworthy as the two things it refuses to do:
// look at anything the trade did AFTER opening, and hand back a model the sample
// cannot support. Both refusals are tested here more carefully than the fit is.

const trade = (o = {}) => ({
  state: "closed", side: "long", outcome: "target",
  entry: 100, stop: 98, target: 104, plannedR: 2, leverage: 10,
  openedAt: Date.parse("2026-08-12T09:00:00Z"), exitAt: Date.parse("2026-08-12T10:00:00Z"),
  riskChecks: { volatility: { label: "0.17%/bar" }, volume: { rvol: 1.4 }, heatUsedPct: 6 },
  ...o,
});

test("features are read only from the entry decision", () => {
  const f = featuresOf(trade());
  assert.equal(f.length, FEATURES.length);
  // Change everything that happened AFTER the entry — the row must not move.
  const after = featuresOf(trade({ outcome: "stop", exit: 90, pnl: -500, R: -1, maxFavR: 0.8 }));
  assert.deepEqual(f, after, "an outcome must never leak into a feature");
});

test("a trade that cannot be described is dropped, not zero-filled", () => {
  assert.equal(featuresOf(trade({ riskChecks: { volume: { rvol: 1.4 } } })), null, "no volatility reading");
  assert.equal(featuresOf(trade({ riskChecks: { volatility: { label: "0.17%/bar" } } })), null, "no rvol");
  assert.equal(featuresOf(trade({ entry: 0 })), null);
  // Zero-filling would teach the model that "missing" means "small".
  const { X } = buildDataset([trade(), trade({ entry: 0 })]);
  assert.equal(X.length, 1);
});

test("only reaching the target counts as a win", () => {
  assert.equal(labelOf(trade({ outcome: "target" })), 1);
  for (const o of ["stop", "invalidated", "eod", "manual", undefined]) {
    assert.equal(labelOf(trade({ outcome: o })), 0, `${o} is not a win`);
  }
});

test("purged folds train only on the past and drop overlapping trades", () => {
  const H = 3600e3;
  const rows = Array.from({ length: 30 }, (_, i) => ({
    openedAt: i * H,
    exitAt: i * H + H * 4,          // every trade overlaps its three successors
  }));
  const folds = purgedFolds(rows, { k: 3, embargoMs: H });
  assert.ok(folds.length > 0);
  for (const f of folds) {
    const testStart = Math.min(...f.test.map((i) => rows[i].openedAt));
    for (const i of f.train) {
      assert.ok(rows[i].openedAt < testStart, "training must be strictly in the past");
      assert.ok(rows[i].exitAt + H < testStart, "an overlapping trade leaks its label and must be purged");
    }
  }
});

test("AUC is undefined rather than 0.5 when a fold has one class", () => {
  assert.equal(auc([0.1, 0.9], [1, 1]), null);
  assert.equal(auc([0.1, 0.9], [0, 0]), null);
  // A perfect ranking is 1, an inverted one is 0.
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
});

test("the regression separates a signal it is actually given", () => {
  // Feature 0 decides the label; the rest is noise. If this cannot be learned,
  // nothing downstream is worth reading.
  const X = [], y = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 200; i++) {
    const signal = rnd();
    X.push([signal, rnd(), rnd()]);
    y.push(signal > 0.5 ? 1 : 0);
  }
  const m = fitLogistic(X, y);
  const scores = X.map((r) => m.predict(r));
  assert.ok(auc(scores, y) > 0.9, "a planted signal must be found");
});

test("THE REFUSAL: a thin ledger yields no model and says what it needs", () => {
  // The live ledger's shape: 95 trades, 27 winners, 10 features.
  const ledger = [
    ...Array.from({ length: 27 }, (_, i) => trade({ outcome: "target", openedAt: i * 3600e3, exitAt: i * 3600e3 + 1800e3 })),
    ...Array.from({ length: 68 }, (_, i) => trade({ outcome: "stop", openedAt: (i + 27) * 3600e3, exitAt: (i + 27) * 3600e3 + 1800e3 })),
  ];
  const s = metaLabelStudy(ledger);
  assert.equal(s.ready, false, "27 winners cannot support 10 features");
  assert.equal(s.positives, 27);
  assert.equal(s.needPositives, FEATURES.length * EVENTS_PER_FEATURE - 27);
  assert.match(s.reason, /rarer class/);
  assert.equal(s.model, undefined, "no model may be returned at all");
});

test("with enough of both classes it fits and reports out-of-sample AUC", () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const ledger = Array.from({ length: 400 }, (_, i) => {
    const rvol = 0.6 + rnd() * 1.8;
    return trade({
      // Higher relative volume genuinely wins more often in this synthetic book.
      outcome: rvol > 1.5 ? (rnd() > 0.25 ? "target" : "stop") : (rnd() > 0.75 ? "target" : "stop"),
      riskChecks: { volatility: { label: "0.17%/bar" }, volume: { rvol }, heatUsedPct: 6 },
      openedAt: i * 3600e3, exitAt: i * 3600e3 + 1800e3,
    });
  });
  const s = metaLabelStudy(ledger);
  assert.equal(s.ready, true, s.reason);
  assert.ok(s.folds >= 2);
  assert.ok(s.auc > 0.6, `the planted edge should show, got AUC ${s.auc}`);
  assert.ok(s.model, "a usable model comes back only once it is earned");
});

test("a ledger of one outcome type is refused, not scored", () => {
  const ledger = Array.from({ length: 300 }, (_, i) => trade({
    outcome: "stop", openedAt: i * 3600e3, exitAt: i * 3600e3 + 1800e3,
  }));
  const s = metaLabelStudy(ledger);
  assert.equal(s.ready, false, "no winners means nothing to learn from");
  assert.equal(s.positives, 0);
});
