import { test } from "node:test";
import assert from "node:assert/strict";
import { cashUSD } from "../src/lib/portfolio.js";

// cashUSD is DERIVED (never stored): Σ deposits.usd − Σ buys + Σ realized sells.
// Passing positions/deposits explicitly keeps the tests storage-free.

test("empty account has zero cash", () => {
  assert.equal(cashUSD([], []), 0);
});

test("deposits add, buys deduct, realized sells return proceeds", () => {
  const deposits = [{ usd: 1000 }];
  const positions = [
    { shares: 2, avgPrice: 100 },                              // open buy → −200
    { shares: 1, avgPrice: 50, sellPrice: 80 },                // closed  → −50 +80
  ];
  assert.equal(cashUSD(positions, deposits), 1000 - 200 - 50 + 80);
});

test("buys without a covering deposit go negative (UI warns)", () => {
  assert.equal(cashUSD([{ shares: 1, avgPrice: 300 }], []), -300);
});

test("a reopened position (sellPrice null) does not credit proceeds", () => {
  const positions = [{ shares: 1, avgPrice: 100, sellPrice: null }];
  assert.equal(cashUSD(positions, [{ usd: 500 }]), 400);
});

test("non-numeric fields coerce safely to 0", () => {
  const positions = [{ shares: "2", avgPrice: "10.5" }]; // strings coerce
  assert.equal(cashUSD(positions, [{ usd: 100 }]), 100 - 21);
  assert.equal(cashUSD([{ shares: NaN, avgPrice: 50 }], []), 0);
});
