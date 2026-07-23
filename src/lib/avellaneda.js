// avellaneda.js — the Avellaneda-Stoikov (2008) market-making model as an
// interactive simulation. The model that turned quoting into a control
// problem: quote around a RESERVATION price (mid, skewed against your
// inventory) with a spread set by risk aversion, volatility, time left and
// how fast orders arrive.
//
//   r  = s − q·γ·σ²·(T−t)                     reservation price
//   δᵃ+δᵇ = γ·σ²·(T−t) + (2/γ)·ln(1 + γ/k)    optimal total spread
//
// Fills are Poisson with intensity λ(δ) = A·e^(−k·δ) — the further you quote
// from the mid, the rarer the fill. All of it honest to the paper; the
// UI's job is to make the γ-tradeoff FELT: raise it and the book hugs flat
// inventory, lower it and it earns more spread while riding bigger swings.

// Deterministic RNG so parameter changes are comparable run-to-run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randn = (rnd) => {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/**
 * Run one Avellaneda-Stoikov session.
 * @param {object} p { gamma, k, sigma, A, T, steps, s0, q0, seed }
 * @returns series + summary metrics
 */
export function simulateAS({
  gamma = 0.1, k = 1.5, sigma = 2, A = 140,
  T = 1, steps = 500, s0 = 100, q0 = 0, seed = 7,
} = {}) {
  const rnd = mulberry32(seed);
  const dt = T / steps;
  let s = s0, q = q0, cash = -q0 * s0; // starting inventory was bought at s0
  const t = [], mid = [], bid = [], ask = [], inv = [], pnl = [], resv = [];
  let fills = 0, spreadSum = 0;

  for (let i = 0; i <= steps; i++) {
    const tau = Math.max(0, T - i * dt);
    const r = s - q * gamma * sigma * sigma * tau;
    const spread = gamma * sigma * sigma * tau + (2 / gamma) * Math.log(1 + gamma / k);
    const b = r - spread / 2;
    const a = r + spread / 2;
    spreadSum += spread;

    // Poisson fills at distance-dependent intensity (at most one per side/step).
    const dB = Math.max(0, s - b);
    const dA = Math.max(0, a - s);
    if (rnd() < 1 - Math.exp(-A * Math.exp(-k * dB) * dt)) { q += 1; cash -= b; fills++; }
    if (rnd() < 1 - Math.exp(-A * Math.exp(-k * dA) * dt)) { q -= 1; cash += a; fills++; }

    t.push(i * dt);
    mid.push(s); bid.push(b); ask.push(a); resv.push(r);
    inv.push(q);
    pnl.push(cash + q * s); // mark-to-market

    s += sigma * Math.sqrt(dt) * randn(rnd); // arithmetic mid, as in the paper
  }

  const maxAbsInv = Math.max(...inv.map(Math.abs));
  return {
    t, mid, bid, ask, resv, inv, pnl,
    summary: {
      finalPnl: +pnl[pnl.length - 1].toFixed(2),
      fills,
      maxAbsInv,
      endInv: q,
      avgSpread: +(spreadSum / (steps + 1)).toFixed(3),
    },
  };
}
