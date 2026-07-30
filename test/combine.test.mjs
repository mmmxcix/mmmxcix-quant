// Strategy combination from stored window profiles — the good-early + good-late
// blend that smooths into consistency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blendProfiles, findComplementaryPairs } from "../src/lib/combine.js";

const wp = (rets) => ({ segments: rets.map((r) => ({ ret: r })) });

test("blendProfiles averages per window and classifies the result", () => {
  const early = wp([0.5, -0.3]);  // good-early
  const late = wp([-0.3, 0.6]);   // good-late
  const b = blendProfiles([early, late]);
  assert.ok(Math.abs(b.returns[0] - 0.1) < 1e-9, "H1 = (0.5-0.3)/2");
  assert.ok(Math.abs(b.returns[1] - 0.15) < 1e-9, "H2 = (-0.3+0.6)/2");
  assert.equal(b.profile, "consistent", "the blend smooths into consistency");
});

test("blendProfiles respects weights and needs matching window counts", () => {
  assert.equal(blendProfiles([wp([0.5, -0.3])]), null, "needs at least two");
  assert.equal(blendProfiles([wp([0.1, 0.1]), wp([0.1, 0.1, 0.1])]), null, "window counts must match");
  const b = blendProfiles([wp([0.4, -0.4]), wp([-0.4, 0.4])], [3, 1]);
  assert.ok(Math.abs(b.returns[0] - (0.75 * 0.4 + 0.25 * -0.4)) < 1e-9, "weighted average");
});

test("findComplementaryPairs surfaces only pairs whose blend is consistent", () => {
  const entries = [
    { id: "a", name: "Decayed", status: "improve", windowProfile: wp([0.5, -0.3]) },   // good-early
    { id: "b", name: "Improving", status: "factory", windowProfile: wp([-0.3, 0.6]) },  // good-late
    { id: "c", name: "Consistent", status: "paper", windowProfile: wp([0.3, 0.3]) },    // not complementary
    { id: "d", name: "Dead", status: "graveyard", windowProfile: wp([-0.4, 0.6]) },     // excluded (buried)
  ];
  const pairs = findComplementaryPairs(entries);
  assert.equal(pairs.length, 1, "only the a+b blend qualifies");
  assert.deepEqual([pairs[0].a.id, pairs[0].b.id].sort(), ["a", "b"]);
  assert.equal(pairs[0].blend.profile, "consistent");
});

test("a pair whose blend is NOT consistent is not surfaced", () => {
  // good-early + good-late but the magnitudes leave the blend still negative early.
  const entries = [
    { id: "a", name: "x", status: "factory", windowProfile: wp([0.1, -0.5]) },
    { id: "b", name: "y", status: "factory", windowProfile: wp([-0.5, 0.1]) },
  ];
  assert.equal(findComplementaryPairs(entries).length, 0);
});
