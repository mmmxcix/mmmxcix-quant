// regimes.js — correlation regime dynamics on live cross-asset data.
//
// The point this module makes: asset correlations are NOT stable. In calm
// markets a mixed basket diversifies; under stress correlations jump toward 1
// (forced selling, margin calls — 2008, March 2020) and diversification fails
// exactly when it is needed. We measure it directly: rolling average pairwise
// correlation across a 6-asset basket, a stress classification, and the
// calm-vs-stress correlation matrices side by side.

import { fetchAligned, dailyReturns } from "./factors.js";

// Equities (large/small cap, tech), duration, gold, crypto — the classic
// "diversified" mix whose correlations converge in a crisis.
export const REGIME_BASKET = [
  ["SPY", "S&P 500"],
  ["QQQ", "Nasdaq 100"],
  ["IWM", "Russell 2000"],
  ["TLT", "20y Treasuries"],
  ["GLD", "Gold"],
  ["BTC-USD", "Bitcoin"],
];

const CACHE_TTL = 15 * 60 * 1000;
let cached = null; // { t, data }

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    cov += a * b; vx += a * a; vy += b * b;
  }
  const d = Math.sqrt(vx * vy);
  return d > 0 ? cov / d : 0;
}

function quantileOf(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** n×n correlation matrix of return arrays restricted to index set `idx`. */
function corrMatrix(retsList, idx) {
  const n = retsList.length;
  const sub = retsList.map((r) => idx.map((i) => r[i]));
  const m = Array.from({ length: n }, () => new Array(n).fill(1));
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      m[a][b] = m[b][a] = pearson(sub[a], sub[b]);
    }
  }
  return m;
}

/**
 * Compute the regime analysis.
 *
 * @returns {{
 *   labels: string[],                       // asset labels (kept order)
 *   avgCorr: {x,y}[],                       // rolling avg pairwise correlation
 *   vol: {x,y}[],                           // rolling annualized vol of asset 0 (%)
 *   stressBands: {x0,x1}[],                 // stress periods (for chart shading)
 *   calmMatrix: number[][], stressMatrix: number[][],
 *   stats: { corrCalm, corrStress, volCalm, volStress, divCalm, divStress, stressSharePct },
 *   meta: { window, from, to, dropped }
 * }}
 */
export async function computeRegimes({ range = "2y", window = 30, onProgress } = {}) {
  if (cached && Date.now() - cached.t < CACHE_TTL) return cached.data;

  const symbols = REGIME_BASKET.map(([s]) => s);
  const { times, closes, dropped } = await fetchAligned(symbols, range, onProgress);
  const kept = REGIME_BASKET.filter(([s]) => closes[s]);
  if (kept.length < 3) throw new Error("Not enough assets loaded for a correlation basket.");

  const labels = kept.map(([, name]) => name);
  const retsList = kept.map(([s]) => dailyReturns(closes[s]));
  const nT = retsList[0].length; // return i spans times[i] → times[i+1]
  if (nT <= window + 10) throw new Error("Not enough history for the rolling window.");

  const n = kept.length;
  const pairs = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) pairs.push([a, b]);

  // Rolling stats at each day t (window ending at t, inclusive).
  const avgCorr = [], vol = [], divRatio = [];
  for (let t = window; t < nT; t++) {
    const lo = t - window;
    let sum = 0;
    const winRets = retsList.map((r) => r.slice(lo, t + 1));
    for (const [a, b] of pairs) sum += pearson(winRets[a], winRets[b]);
    const x = times[t + 1];
    avgCorr.push({ x, y: sum / pairs.length });

    // Annualized vol of the lead asset (SPY) — the classic stress gauge.
    const w = winRets[0];
    const mean = w.reduce((a, r) => a + r, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, r) => a + (r - mean) * (r - mean), 0) / w.length);
    vol.push({ x, y: sd * Math.sqrt(252) * 100 });

    // Diversification ratio of the equal-weight basket: avg asset vol /
    // portfolio vol. High = diversification working; →1 = one big trade.
    const vols = winRets.map((r) => {
      const m = r.reduce((a, v) => a + v, 0) / r.length;
      return Math.sqrt(r.reduce((a, v) => a + (v - m) * (v - m), 0) / r.length);
    });
    const port = winRets[0].map((_, i) => winRets.reduce((a, r) => a + r[i], 0) / n);
    const pm = port.reduce((a, v) => a + v, 0) / port.length;
    const pv = Math.sqrt(port.reduce((a, v) => a + (v - pm) * (v - pm), 0) / port.length);
    divRatio.push(pv > 0 ? vols.reduce((a, v) => a + v, 0) / n / pv : 1);
  }

  // Stress = top-30% average correlation days. (Classifying on correlation
  // itself is the honest choice here — the module is ABOUT correlation.)
  const thr = quantileOf(avgCorr.map((p) => p.y), 0.7);
  const stress = avgCorr.map((p) => p.y >= thr);

  // Contiguous stress bands for chart shading.
  const stressBands = [];
  for (let i = 0; i < stress.length; i++) {
    if (!stress[i]) continue;
    const start = i;
    while (i + 1 < stress.length && stress[i + 1]) i++;
    stressBands.push({ x0: avgCorr[start].x, x1: avgCorr[i].x });
  }

  // Calm vs stress correlation matrices over the raw daily returns.
  const calmIdx = [], stressIdx = [];
  for (let i = 0; i < stress.length; i++) (stress[i] ? stressIdx : calmIdx).push(window + i);
  const calmMatrix = corrMatrix(retsList, calmIdx);
  const stressMatrix = corrMatrix(retsList, stressIdx);

  const avgOf = (arr, idxs) => (idxs.length ? idxs.reduce((a, i) => a + arr[i].y, 0) / idxs.length : 0);
  const avgOfPlain = (arr, idxs) => (idxs.length ? idxs.reduce((a, i) => a + arr[i], 0) / idxs.length : 0);
  const sel = (flag) => stress.map((s, i) => (s === flag ? i : -1)).filter((i) => i >= 0);
  const calmSel = sel(false), stressSel = sel(true);

  const data = {
    labels,
    avgCorr,
    vol,
    stressBands,
    calmMatrix,
    stressMatrix,
    stats: {
      corrCalm: avgOf(avgCorr, calmSel),
      corrStress: avgOf(avgCorr, stressSel),
      volCalm: avgOf(vol, calmSel),
      volStress: avgOf(vol, stressSel),
      divCalm: avgOfPlain(divRatio, calmSel),
      divStress: avgOfPlain(divRatio, stressSel),
      stressSharePct: (stressSel.length / stress.length) * 100,
    },
    meta: { window, from: avgCorr[0]?.x, to: avgCorr[avgCorr.length - 1]?.x, dropped },
  };
  cached = { t: Date.now(), data };
  return data;
}
