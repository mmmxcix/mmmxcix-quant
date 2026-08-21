import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dailyReturnsOf, dailyCloseReturns, poolDaily, sharpeDaily, maxDrawdownPctDaily,
  totalReturnPctDaily, foldsProfitable, tailStats, corrDaily, pooledProfitFactor,
  compactSeries, ensembleGrade,
} from "../src/lib/ensemble.js";

const DAY = 86400;
const T0 = 1_700_000_000 - (1_700_000_000 % DAY); // midnight-aligned so bars stay in-day

// equity curve helper: one mark per day at the given values
const curve = (values, t0 = T0) => values.map((v, i) => ({ time: t0 + i * DAY + 3600, value: v }));

test("dailyReturnsOf takes the last mark per UTC day and chains returns", () => {
  // two marks on day 0 (100 then 110) → day 0 closes at 110; day 1 closes 121
  const eq = [
    { time: T0 + 3600, value: 100 },
    { time: T0 + 7200, value: 110 },
    { time: T0 + DAY + 3600, value: 121 },
  ];
  const r = dailyReturnsOf(eq);
  assert.equal(r.length, 1);
  assert.ok(Math.abs(r[0].r - 0.1) < 1e-12);
});

test("dailyReturnsOf stops at ruin (equity 0) instead of dividing by zero", () => {
  const r = dailyReturnsOf(curve([100, 0, 50]));
  assert.equal(r.length, 1); // 100→0 is the last return; nothing after ruin
  assert.equal(r[0].r, -1);
});

test("poolDaily averages only the series reporting each date", () => {
  const a = [{ d: "2024-01-02", r: 0.02 }, { d: "2024-01-03", r: 0.02 }];
  const b = [{ d: "2024-01-03", r: -0.01 }];
  const p = poolDaily([a, b]);
  assert.deepEqual(p.dates, ["2024-01-02", "2024-01-03"]);
  assert.ok(Math.abs(p.returns[0] - 0.02) < 1e-12);       // a alone
  assert.ok(Math.abs(p.returns[1] - 0.005) < 1e-12);      // mean of a and b
});

test("pooling k uncorrelated legs lifts Sharpe ≈ √k — the diversification engine", () => {
  // two alternating-return legs, offset so they are anti-phased → pooled variance shrinks
  const n = 504;
  const legA = [], legB = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2020, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    legA.push({ d, r: 0.001 + (i % 2 ? 0.01 : -0.01) });
    legB.push({ d, r: 0.001 + (i % 2 ? -0.01 : 0.01) });
  }
  const sA = sharpeDaily(legA.map((x) => x.r));
  const pooled = sharpeDaily(poolDaily([legA, legB]).returns);
  assert.ok(pooled > sA * 3, `pooled ${pooled} should crush single-leg ${sA}`);
});

test("sharpeDaily is 0 below the observation floor and for zero variance", () => {
  assert.equal(sharpeDaily([0.01, 0.01], 20), 0);
  assert.equal(sharpeDaily(new Array(50).fill(0)), 0);
});

test("drawdown and total return agree with hand math", () => {
  const rets = [0.1, -0.5, 0.2]; // 1 → 1.1 → 0.55 → 0.66
  assert.ok(Math.abs(totalReturnPctDaily(rets) - -34) < 1e-9);
  assert.ok(Math.abs(maxDrawdownPctDaily(rets) - 50) < 1e-9);
});

test("foldsProfitable counts profitable contiguous slices and respects the 40-obs floor", () => {
  const up = new Array(200).fill(0.001);
  assert.deepEqual(foldsProfitable(up, 5), { profitable: 5, total: 5 });
  const short = new Array(60).fill(0.001); // only 1 fold fits at ≥40 obs
  assert.equal(foldsProfitable(short, 5).total, 1);
});

test("tailStats reads the recent slice only", () => {
  const rets = [...new Array(70).fill(0.002), ...new Array(30).fill(-0.004)];
  const t = tailStats(rets, 0.3);
  assert.equal(t.n, 30);
  assert.ok(t.retPct < 0);
});

test("corrDaily: perfect correlation on overlap, null when overlap is thin", () => {
  const mk = (rs) => {
    const dates = rs.map((_, i) => new Date(Date.UTC(2021, 0, 1) + i * 864e5).toISOString().slice(0, 10));
    return { dates, returns: rs };
  };
  const base = Array.from({ length: 120 }, (_, i) => Math.sin(i) * 0.01);
  assert.ok(Math.abs(corrDaily(mk(base), mk(base)) - 1) < 1e-9);
  assert.ok(corrDaily(mk(base), mk(base.map((r) => -r))) < -0.99);
  assert.equal(corrDaily(mk(base.slice(0, 10)), mk(base.slice(0, 10))), null);
});

test("pooledProfitFactor sums wins and losses across markets", () => {
  const pf = pooledProfitFactor([[{ pnl: 30 }, { pnl: -10 }], [{ pnl: -10 }]]);
  assert.ok(Math.abs(pf - 1.5) < 1e-12);
  assert.equal(pooledProfitFactor([[{ pnl: 5 }]]), Infinity);
});

test("ensembleGrade applies the hard bars at book level", () => {
  const steady = (r) => {
    const dates = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2022, 0, 1) + i * 864e5).toISOString().slice(0, 10));
    return { series: dates.map((d, i) => ({ d, r: r + (i % 2 ? 0.004 : -0.004) })) };
  };
  const g = ensembleGrade([steady(0.002).series, steady(0.002).series.map((x) => ({ d: x.d, r: x.r }))], null);
  assert.ok(g.sharpe > 1);
  assert.equal(g.quantGrade, true);
  const weak = ensembleGrade([steady(0.00001).series], null);
  assert.equal(weak.quantGrade, false);
});

test("compactSeries rounds without destroying the shape", () => {
  const c = compactSeries({ dates: ["2024-01-01"], returns: [0.0123456789] });
  assert.deepEqual(c, { dates: ["2024-01-01"], returns: [0.01235] });
});

test("dailyCloseReturns mirrors buy&hold of the candles", () => {
  const candles = [0, 1, 2].map((i) => ({ time: T0 + i * DAY + 3600, close: 100 * (1 + 0.01 * i) }));
  const r = dailyCloseReturns(candles);
  assert.equal(r.length, 2);
  assert.ok(Math.abs(r[0].r - 0.01) < 1e-9);
});
