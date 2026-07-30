// The time-window failure memory — the basis for Cortex spotting complementary
// strategies. Pins the classification of each shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { windowProfile, areComplementary } from "../src/lib/windowProfile.js";

// Build an equity curve that rises by `a` over the first half and by `b` over
// the second (compounded), so we control each window's return exactly.
function curve(a, b, n = 200) {
  const out = [];
  const half = Math.floor(n / 2);
  for (let i = 0; i < n; i++) {
    const inFirst = i < half;
    const frac = inFirst ? i / half : (i - half) / (n - half);
    const v = inFirst ? 1 + a * frac : (1 + a) * (1 + b * frac);
    out.push({ time: i * 86400, value: v });
  }
  return out;
}

test("windowProfile needs enough bars to slice", () => {
  assert.equal(windowProfile([{ time: 0, value: 1 }], { segments: 2 }), null);
});

test("consistent: both halves up", () => {
  const p = windowProfile(curve(0.3, 0.3), { segments: 2 });
  assert.equal(p.profile, "consistent");
  assert.match(p.summary, /held throughout/);
});

test("good-early: up then down (decayed edge)", () => {
  const p = windowProfile(curve(0.5, -0.3), { segments: 2 });
  assert.equal(p.profile, "good-early");
  assert.match(p.summary, /arbitraged away/);
  assert.equal(p.best, 0);
  assert.equal(p.worst, 1);
});

test("good-late: down then up (improving)", () => {
  const p = windowProfile(curve(-0.3, 0.6), { segments: 2 });
  assert.equal(p.profile, "good-late");
  assert.match(p.summary, /current regime/);
});

test("unprofitable: both halves down", () => {
  const p = windowProfile(curve(-0.3, -0.3), { segments: 2 });
  assert.equal(p.profile, "unprofitable");
});

test("areComplementary matches good-early with good-late, not like with like", () => {
  const early = windowProfile(curve(0.5, -0.3), { segments: 2 });
  const late = windowProfile(curve(-0.3, 0.6), { segments: 2 });
  const consistent = windowProfile(curve(0.3, 0.3), { segments: 2 });
  assert.ok(areComplementary(early, late), "early + late are complementary");
  assert.ok(!areComplementary(early, early), "early + early are not");
  assert.ok(!areComplementary(early, consistent), "early + consistent are not");
});

test("supports finer segmentation (quarters)", () => {
  const p = windowProfile(curve(0.4, -0.2), { segments: 4 });
  assert.equal(p.segments.length, 4);
  assert.ok(["good-early", "erratic", "consistent", "good-late", "unprofitable"].includes(p.profile));
});
