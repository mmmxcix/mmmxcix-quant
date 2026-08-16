// resolve.js — what an open position was actually worth in the end.
//
// Marking an open position at the last traded price removes the disposition
// effect's advantage, which is why it came first — it is free and it is unbiased
// with respect to the habit. But it is not the truth: a market that resolves
// against a wallet AFTER the cut-off is not punished by a last-price mark, and a
// wallet holding a 12-cent lottery ticket that expires worthless still shows 12
// cents of value.
//
// The truth is on-chain. Gnosis' Conditional Tokens contract — the one
// Polymarket settles on, 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045 on Polygon —
// emits, when an oracle reports:
//
//   ConditionResolution(bytes32 indexed conditionId, address indexed oracle,
//                       bytes32 indexed questionId, uint outcomeSlotCount,
//                       uint[] payoutNumerators)
//
// topic0 = 0xb44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894.
// A share of outcome i is redeemable for payoutNumerators[i] / Σ payout, so
// [0, 1] on a binary market means "outcome 2 paid a dollar, outcome 1 paid
// nothing" — exactly the number an open position needs.
//
// The missing link used to be that a token id (an ERC-1155 position id) cannot
// be inverted back to its conditionId: the derivation runs through an elliptic
// curve point, forwards only. The orderbook subgraph closes it — its `MarketData`
// entity is keyed by token id and carries { condition, outcomeIndex }.
//
// Pure functions: decoding and lookup. The fetching lives in
// scripts/polymarket-resolutions.mjs.

export const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const CONDITION_RESOLUTION_TOPIC =
  "0xb44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894";

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const toInt = (w) => {
  // Payout numerators are small (0, 1, or a split like 50/50); BigInt keeps the
  // decode exact and Number() is safe once we know the magnitude.
  const v = BigInt("0x" + w);
  return v > 9007199254740991n ? Number.MAX_SAFE_INTEGER : Number(v);
};

/**
 * Decode one ConditionResolution log.
 *
 * Non-indexed payload is (uint outcomeSlotCount, uint[] payoutNumerators), so
 * the words are [slotCount][offset][length][…elements]. The offset is read
 * rather than assumed: it is always 0x40 in practice, and trusting that without
 * checking is the kind of shortcut that decodes silently wrong on the one filer
 * who does something else.
 *
 * @returns {null|{conditionId, oracle, questionId, payouts: number[], total}}
 */
export function decodeResolution(log) {
  const topics = log?.topics || [];
  if (topics.length < 4 || topics[0].toLowerCase() !== CONDITION_RESOLUTION_TOPIC) return null;
  const data = String(log.data || "");
  if (data.length < 2 + 64 * 3) return null;

  const slotCount = toInt(word(data, 0));
  const offsetBytes = toInt(word(data, 1));
  const base = offsetBytes / 32;                        // offset is in BYTES
  if (!Number.isInteger(base) || base < 2) return null;
  const len = toInt(word(data, base));
  if (!(len > 0) || len > 256) return null;             // a sane outcome count
  if (data.length < 2 + 64 * (base + 1 + len)) return null;

  const payouts = [];
  for (let i = 0; i < len; i++) payouts.push(toInt(word(data, base + 1 + i)));
  const total = payouts.reduce((a, b) => a + b, 0);
  // An oracle that reports all zeros has not resolved anything payable; treating
  // that as "everything is worthless" would be a decision the chain did not make.
  if (!(total > 0)) return null;

  return {
    conditionId: topics[1].toLowerCase(),
    oracle: "0x" + topics[2].slice(26).toLowerCase(),
    questionId: topics[3].toLowerCase(),
    slotCount, payouts, total,
    blockNumber: Number(log.blockNumber),
  };
}

/**
 * A lookup from token id to its terminal value per share, in dollars.
 *
 * @param {Map|object} tokenMap    tokenId → { condition, outcomeIndex }
 * @param {Map|object} resolutions conditionId → { payouts, total, blockNumber }
 * @param {(blockNumber:number)=>number} [blockTime] block → unix seconds, so a
 *        resolution AFTER the valuation edge can be refused rather than used —
 *        knowing how a market ended is exactly the information a study must not
 *        borrow from the future.
 */
export function resolvedValue(tokenMap, resolutions, blockTime = null) {
  const get = (m, k) => (m instanceof Map ? m.get(k) : m[k]);
  return {
    /**
     * @returns {null|number} dollars per share, or null when the token has no
     *          mapping, its condition never resolved, or it resolved only after
     *          `atTs` — all three are different kinds of "we do not know", and
     *          none of them may be quietly rounded to zero.
     */
    at(tokenId, atTs = Infinity) {
      const m = get(tokenMap, String(tokenId));
      if (!m || m.condition == null || m.outcomeIndex == null) return null;
      const r = get(resolutions, String(m.condition).toLowerCase());
      if (!r || !(r.total > 0)) return null;
      if (blockTime && atTs !== Infinity) {
        const ts = blockTime(r.blockNumber);
        if (ts == null || ts > atTs) return null;       // resolved after the edge
      }
      const i = Number(m.outcomeIndex);
      if (!Number.isInteger(i) || i < 0 || i >= r.payouts.length) return null;
      return r.payouts[i] / r.total;
    },
  };
}
