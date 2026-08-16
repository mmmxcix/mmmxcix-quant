// Polymarket fills, FIFO P&L, and what a copier actually gets.
//
// The properties that would make a RESULT wrong:
//
//   · the side of a fill is read from which leg is cash, and getting it backwards
//     turns every loss into a gain
//   · a copier commits the same CASH, so a worse price buys FEWER shares — the
//     mistake that hides slippage entirely is assuming the same share count
//   · a sell with no inventory is a short we cannot price, and booking it at zero
//     cost would credit the whole proceeds as profit
//   · ranking in sample and judging out of sample must be corrected for having
//     looked at hundreds of wallets

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTRACTS, decodeFill, fifoPnl, splitAt, walletScore, walletTrades } from "../src/lib/polymarket/trades.js";
import { copyFill, persistence, replayCopy, spearman, walletPValue } from "../src/lib/polymarket/copy.js";
import { CONDITION_RESOLUTION_TOPIC, decodeResolution, resolvedValue } from "../src/lib/polymarket/resolve.js";

const fill = (o = {}) => ({
  id: o.id || "x", timestamp: String(o.ts ?? 1_700_000_000),
  maker: o.maker || "0xaaaa000000000000000000000000000000000001",
  taker: o.taker || "0xbbbb000000000000000000000000000000000002",
  makerAssetId: o.makerAssetId ?? "0",
  takerAssetId: o.takerAssetId ?? "999",
  makerAmountFilled: String(o.makerAmount ?? 300_000),   // $0.30
  takerAmountFilled: String(o.takerAmount ?? 1_000_000), // 1 share
  fee: String(o.fee ?? 0),
});

test("the cash leg decides the side, and the price is usdc per share", () => {
  const buy = decodeFill(fill());
  assert.equal(buy.side, "buy");
  assert.equal(buy.usdc, 0.3);
  assert.equal(buy.tokens, 1);
  assert.ok(Math.abs(buy.price - 0.3) < 1e-12);

  // Mirror it: the maker now delivers shares and receives cash.
  const sell = decodeFill(fill({ makerAssetId: "999", takerAssetId: "0", makerAmount: 1_000_000, takerAmount: 300_000 }));
  assert.equal(sell.side, "sell");
  assert.equal(sell.tokens, 1);
  assert.equal(sell.usdc, 0.3);
  assert.equal(sell.tokenId, "999");
});

test("anything that is not cash-for-shares at a possible price is refused", () => {
  assert.equal(decodeFill(fill({ makerAssetId: "5", takerAssetId: "7" })), null, "token-for-token is a split/merge");
  assert.equal(decodeFill(fill({ makerAssetId: "0", takerAssetId: "0" })), null);
  assert.equal(decodeFill(fill({ makerAmount: 0 })), null);
  // A share of a binary outcome cannot cost a dollar or more.
  assert.equal(decodeFill(fill({ makerAmount: 1_000_000, takerAmount: 1_000_000 })), null);
  assert.equal(decodeFill(fill({ makerAmount: 2_000_000, takerAmount: 1_000_000 })), null);
});

test("only the maker side is the wallet's own trade, and the exchange is not a wallet", () => {
  const me = "0xaaaa000000000000000000000000000000000001";
  const rows = [fill({ ts: 1 }), fill({ ts: 2, maker: "0xdead000000000000000000000000000000000003" })];
  assert.equal(walletTrades(me, rows).length, 1, "the row where we were the TAKER prices the other party");
  const exchange = [...CONTRACTS][0];
  assert.equal(walletTrades(exchange, [fill({ maker: exchange })]).length, 0);
});

test("FIFO realises only what was bought AND sold, and says how much stayed open", () => {
  const t = (side, price, tokens, ts) => ({ side, price, tokens, usdc: price * tokens, tokenId: "A", ts });
  const p = fifoPnl([
    t("buy", 0.20, 100, 1),
    t("buy", 0.40, 100, 2),
    t("sell", 0.50, 100, 3),   // closes the 0.20 lot: +30
  ]);
  assert.ok(Math.abs(p.realized - 30) < 1e-9);
  assert.ok(Math.abs(p.closedCost - 20) < 1e-9, "the capital actually committed and returned");
  assert.ok(Math.abs(p.openCost - 40) < 1e-9, "the unmeasured half stays visible");
  const s = walletScore(p);
  assert.ok(Math.abs(s.roi - 1.5) < 1e-9);
  assert.ok(Math.abs(s.openShare - 40 / 60) < 1e-9);
});

test("a sell with no inventory is skipped, never booked as pure profit", () => {
  const p = fifoPnl([{ side: "sell", price: 0.9, tokens: 100, usdc: 90, tokenId: "A", ts: 1 }]);
  assert.equal(p.realized, 0);
  assert.equal(p.closedCost, 0);
  assert.equal(walletScore(p), null, "no committed capital means no score, not a score of zero");
});

test("the copier fills at the next print after the delay, never at the leader's price", () => {
  const leader = { ts: 1000, tokenId: "A", side: "buy", price: 0.30, usdc: 30, tokens: 100 };
  const tape = [
    { ts: 1010, price: 0.31 },   // inside the delay — not ours
    { ts: 1070, price: 0.34 },   // the first print we could have hit
    { ts: 1200, price: 0.28 },
  ];
  const f = copyFill(leader, tape, { delaySec: 60, windowSec: 3600 });
  assert.equal(f.price, 0.34);
  assert.equal(f.lagSec, 70);
  assert.ok(f.slipPct > 0, "buying higher than the leader is slippage AGAINST us");

  // Selling lower than the leader is also against us — one sign convention.
  const sell = copyFill({ ...leader, side: "sell" }, [{ ts: 1070, price: 0.28 }], { delaySec: 60 });
  assert.ok(sell.slipPct > 0);

  // A tape that prints nothing in the window is a copy that never happened.
  assert.equal(copyFill(leader, [{ ts: 1010, price: 0.31 }], { delaySec: 60, windowSec: 100 }), null);
});

test("the copier commits the same CASH, so a worse price buys fewer shares", () => {
  const trades = [
    { ts: 1000, tokenId: "A", side: "buy", price: 0.30, usdc: 30, tokens: 100 },
    { ts: 5000, tokenId: "A", side: "sell", price: 0.50, usdc: 50, tokens: 100 },
  ];
  const tape = { A: [{ ts: 1070, price: 0.40 }, { ts: 5070, price: 0.45 }] };
  const out = replayCopy(trades, (id, from) => tape[id].filter((f) => f.ts >= from), { delaySec: 60 });
  assert.equal(out.filled, 2);
  // $30 at 0.40 is 75 shares, sold at 0.45 → +3.75. The leader made +20 on the
  // same two trades; the whole difference is the fill.
  assert.ok(Math.abs(out.realized - 3.75) < 1e-9, `copier realised ${out.realized}`);
  assert.ok(Math.abs(out.closedCost - 30) < 1e-9);
});

test("a copy that could not be entered is never exited", () => {
  const trades = [
    { ts: 1000, tokenId: "A", side: "buy", price: 0.30, usdc: 30, tokens: 100 },
    { ts: 5000, tokenId: "A", side: "sell", price: 0.90, usdc: 90, tokens: 100 },
  ];
  // Nothing prints after the buy, but the sell would have filled.
  const tape = { A: [{ ts: 5070, price: 0.90 }] };
  const out = replayCopy(trades, (id, from) => tape[id].filter((f) => f.ts >= from), { delaySec: 60, windowSec: 600 });
  assert.equal(out.missed, 1);
  assert.equal(out.realized, 0, "you cannot sell what you never managed to buy");
});

test("splitting at the cutoff keeps the two windows apart", () => {
  const trades = [{ ts: 10 }, { ts: 99 }, { ts: 100 }, { ts: 200 }];
  const { inSample, outSample } = splitAt(trades, 100);
  assert.deepEqual(inSample.map((t) => t.ts), [10, 99]);
  assert.deepEqual(outSample.map((t) => t.ts), [100, 200]);
});

test("persistence corrects for having tested every wallet at once", () => {
  // Twenty wallets whose out-of-sample record is pure noise: BH must keep ~none.
  const rows = Array.from({ length: 40 }, (_, i) => {
    const rets = Array.from({ length: 30 }, (_, k) => ((i * 7 + k * 13) % 21 - 10) / 100);
    return {
      address: `0x${i}`, inRoi: (i % 11) / 10 - 0.5, inTrades: 50,
      outTrades: 30, outRoi: rets.reduce((a, b) => a + b, 0) / 30,
      outPnl: rets.reduce((a, b) => a + b, 0) * 100, outCost: 3000,
      pValue: walletPValue(rets),
    };
  });
  const p = persistence(rows, { topK: 5, alpha: 0.1 });
  assert.equal(p.tested, 40);
  assert.ok(p.bh.survivors.length <= 4, `noise produced ${p.bh.survivors.length} survivors`);
  assert.ok(Math.abs(p.rankCorrelation) < 0.6, "and the in/out ranking should not line up");

  // Wallets below the trade floors are not tested at all rather than tested badly.
  const thin = persistence([{ address: "0x0", inRoi: 5, inTrades: 3, outTrades: 1, outRoi: 9, outPnl: 9, outCost: 1, pValue: 0.001 }], {});
  assert.equal(thin.tested, 0);
  assert.equal(thin.skipped, 1);
});

test("spearman finds a monotone relationship and not a scrambled one", () => {
  assert.ok(spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]) > 0.99);
  assert.ok(spearman([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]) < -0.99);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [3, 1, 5, 2, 4])) < 0.6);
});

test("a wallet with too few out-of-sample trades gets no p-value worth having", () => {
  assert.equal(walletPValue([0.5, 0.4, 0.6]), 1, "three trades is not evidence");
  const good = walletPValue(Array.from({ length: 40 }, () => 0.05));
  assert.ok(good < 0.001, "forty consistent winners should be significant before correction");
});

// ── the on-chain resolution ────────────────────────────────────────────────

test("a ConditionResolution decodes to the payout that values an open position", () => {
  // (uint outcomeSlotCount, uint[] payoutNumerators) = (2, [0, 1]) — "outcome 2
  // paid a dollar". Words: [slotCount][offset=0x40][length][p0][p1].
  const w = (n) => n.toString(16).padStart(64, "0");
  const log = {
    topics: [
      CONDITION_RESOLUTION_TOPIC,
      "0xc3d4155148681756bfe67bb41d8d0882a8a122e7d3762b3591bf6598c9bd198b",
      "0x000000000000000000000000" + "1".repeat(40),
      "0xdead" + "0".repeat(60),
    ],
    data: "0x" + w(2) + w(0x40) + w(2) + w(0) + w(1),
    blockNumber: "0x1234",
  };
  const r = decodeResolution(log);
  assert.deepEqual(r.payouts, [0, 1]);
  assert.equal(r.total, 1);
  assert.equal(r.blockNumber, 0x1234);
  assert.equal(r.oracle, "0x" + "1".repeat(40));
});

test("an unresolved or malformed resolution yields nothing rather than a zero payout", () => {
  const w = (n) => n.toString(16).padStart(64, "0");
  const topics = [CONDITION_RESOLUTION_TOPIC, "0x" + "a".repeat(64), "0x" + "0".repeat(64), "0x" + "b".repeat(64)];
  // All-zero numerators: the oracle reported nothing payable. Treating that as
  // "the position is worthless" would be a decision the chain did not make.
  assert.equal(decodeResolution({ topics, data: "0x" + w(2) + w(0x40) + w(2) + w(0) + w(0), blockNumber: "0x1" }), null);
  assert.equal(decodeResolution({ topics, data: "0x" + w(2) }), null, "truncated data");
  assert.equal(decodeResolution({ topics: topics.slice(0, 2), data: "0x" }), null, "wrong topic count");
  assert.equal(decodeResolution({ topics: ["0xdeadbeef", ...topics.slice(1)], data: "0x" }), null, "wrong event");
});

test("a payout is refused when it was only decided AFTER the valuation edge", () => {
  const tokenMap = { "111": { condition: "0xabc", outcomeIndex: 1 }, "222": { condition: "0xzzz", outcomeIndex: 0 } };
  const resolutions = { "0xabc": { payouts: [0, 1], total: 1, blockNumber: 1000 } };
  const clock = (b) => b * 10;                      // block 1000 → t = 10_000

  const v = resolvedValue(tokenMap, resolutions, clock);
  assert.equal(v.at("111", 20_000), 1, "resolved before the edge — usable");
  assert.equal(v.at("111", 5_000), null, "resolved AFTER the edge — knowing it is borrowing the future");
  assert.equal(v.at("222", Infinity), null, "condition never resolved");
  assert.equal(v.at("999", Infinity), null, "token has no mapping");

  // A loser is worth zero, and that is a real number, not a missing one.
  const loser = resolvedValue({ "111": { condition: "0xabc", outcomeIndex: 0 } }, resolutions, clock);
  assert.equal(loser.at("111", 20_000), 0);
});
