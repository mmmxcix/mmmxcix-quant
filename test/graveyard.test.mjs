import { test } from "node:test";
import assert from "node:assert/strict";
import { graveyardDaysLeft, GRAVEYARD_TTL_DAYS } from "../src/lib/registry.js";

const DAY = 86_400_000;

test("graveyardDaysLeft is null for a strategy that isn't buried", () => {
  assert.equal(graveyardDaysLeft({ status: "paper", statusAt: Date.now() }), null);
  assert.equal(graveyardDaysLeft(null), null);
});

test("a freshly buried strategy has the full rescue window", () => {
  assert.equal(graveyardDaysLeft({ status: "graveyard", statusAt: Date.now() }), GRAVEYARD_TTL_DAYS);
});

test("the countdown decreases with age and never goes negative", () => {
  const buried = (days) => ({ status: "graveyard", statusAt: Date.now() - days * DAY });
  assert.equal(graveyardDaysLeft(buried(3)), GRAVEYARD_TTL_DAYS - 3);
  assert.equal(graveyardDaysLeft(buried(13)), 1);
  assert.equal(graveyardDaysLeft(buried(14)), 0);
  assert.equal(graveyardDaysLeft(buried(99)), 0); // clamped, due for deletion
});

test("falls back to createdAt when a legacy entry has no statusAt", () => {
  assert.equal(graveyardDaysLeft({ status: "graveyard", createdAt: Date.now() - 2 * DAY }), GRAVEYARD_TTL_DAYS - 2);
});
