// keccak.js — Keccak-256, because a guessed function selector is not a selector.
//
// WHY THIS IS HERE AT ALL. The resolution scan through `eth_getLogs` is dead on
// a free plan: Alchemy's free tier caps a log range at TEN blocks, which is 5.7
// million requests for this history. But the same fact is also readable as
// contract STATE — `payoutDenominator(conditionId)` and
// `payoutNumerators(conditionId, i)` are public getters on the Conditional
// Tokens contract — and `eth_call` has no range limit at all. Archive `eth_call`
// and JSON-RPC batching both verified working on the free tier.
//
// Calling them needs their 4-byte selectors, which are the first four bytes of
// keccak256 of the signature. Node ships SHA3-256, which is NOT keccak256 — the
// padding differs — and this project's rule is that a value nobody verified does
// not get used. So: 60 lines of Keccak, checked against two vectors that make it
// impossible to be subtly wrong (see test/polymarket.test.mjs):
//
//   keccak256("")  = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
//   keccak256("ConditionResolution(bytes32,address,bytes32,uint256,uint256[])")
//                  = b44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894
//
// The second one is the event topic that was independently decoded off a real
// log on 16 Aug 2026. If this implementation reproduces it from the signature
// string alone, it is not subtly wrong.
//
// BigInt lanes rather than 32-bit halves: slower per hash and far easier to read,
// and the whole workload here is a few thousand hashes.

const MASK = (1n << 64n) - 1n;

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808An, 0x8000000080008000n,
  0x000000000000808Bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008An, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000An,
  0x000000008000808Bn, 0x800000000000008Bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800An, 0x800000008000000An,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rho offsets, indexed lane = x + 5y.
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    // θ
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D;
    }
    // ρ and π
    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
      }
    }
    // χ
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y] & MASK);
      }
    }
    // ι
    A[0] ^= RC[round];
  }
  return A;
}

/** @param {Uint8Array} bytes @returns {string} 64 lowercase hex chars, no 0x. */
export function keccak256(bytes) {
  const RATE = 136;                                  // 1088 bits, the 256-bit variant
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / RATE) * RATE);
  padded.set(bytes);
  padded[bytes.length] |= 0x01;                      // Keccak padding — NOT SHA-3's 0x06
  padded[padded.length - 1] |= 0x80;

  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }

  let out = "";
  for (let i = 0; i < 4; i++) {                      // 4 lanes = 32 bytes
    let lane = A[i];
    for (let b = 0; b < 8; b++) {
      out += (lane & 0xffn).toString(16).padStart(2, "0");
      lane >>= 8n;
    }
  }
  return out;
}

/** keccak256 of a UTF-8 string. */
export const keccakText = (s) => keccak256(new TextEncoder().encode(s));

/** The 4-byte selector of a Solidity signature, e.g. "payoutDenominator(bytes32)". */
export const selector = (sig) => "0x" + keccakText(sig).slice(0, 8);
