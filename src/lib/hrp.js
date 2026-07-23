// hrp.js — Hierarchical Risk Parity (López de Prado, 2016) in plain JS.
//
// The mean-variance optimizer everyone starts with inverts the covariance
// matrix, which is numerically unstable and famously concentrates weight on a
// few assets out-of-sample. HRP never inverts anything: it clusters assets by
// correlation, orders them so similar assets sit together, then splits risk
// down the tree by inverse variance. The result is a diversified, stable
// allocation — Jansen/awesome-quant's recommended baseline.
//
// All functions are pure and dependency-free so they can be unit-tested in
// Node exactly as they run in the browser.

/** Log-return series per symbol → aligned matrix (rows = time, cols = symbol),
 *  keeping only the overlapping tail all symbols share. */
export function alignReturns(returnsBySym) {
  const syms = Object.keys(returnsBySym);
  const minLen = Math.min(...syms.map((s) => returnsBySym[s].length));
  const rows = [];
  for (let i = 0; i < minLen; i++) {
    rows.push(syms.map((s) => {
      const arr = returnsBySym[s];
      return arr[arr.length - minLen + i];
    }));
  }
  return { syms, rows };
}

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

/** Covariance + correlation matrices from an aligned return matrix. */
export function covCorr(rows) {
  const n = rows.length, k = rows[0].length;
  const cols = Array.from({ length: k }, (_, j) => rows.map((r) => r[j]));
  const mu = cols.map(mean);
  const cov = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let a = 0; a < k; a++) {
    for (let b = a; b < k; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += (cols[a][i] - mu[a]) * (cols[b][i] - mu[b]);
      cov[a][b] = cov[b][a] = s / (n - 1);
    }
  }
  const sd = cov.map((row, i) => Math.sqrt(row[i]) || 1e-12);
  const corr = Array.from({ length: k }, (_, a) =>
    Array.from({ length: k }, (_, b) => cov[a][b] / (sd[a] * sd[b])));
  return { cov, corr, sd };
}

// Average-linkage agglomerative clustering on the correlation distance
// d = sqrt(0.5 (1 − ρ)). Returns the merge order as a binary tree of indices.
function clusterTree(corr) {
  const k = corr.length;
  const dist = (a, b) => Math.sqrt(Math.max(0, 0.5 * (1 - corr[a][b])));
  let clusters = Array.from({ length: k }, (_, i) => ({ leaf: i, members: [i] }));
  // pairwise cluster distance = average over member pairs (UPGMA)
  const cdist = (c1, c2) => {
    let s = 0;
    for (const a of c1.members) for (const b of c2.members) s += dist(a, b);
    return s / (c1.members.length * c2.members.length);
  };
  while (clusters.length > 1) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const d = cdist(clusters[i], clusters[j]);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    const merged = {
      left: clusters[bi], right: clusters[bj],
      members: [...clusters[bi].members, ...clusters[bj].members],
    };
    clusters = clusters.filter((_, i) => i !== bi && i !== bj);
    clusters.push(merged);
  }
  return clusters[0];
}

/** Quasi-diagonalization: leaf order from an in-order walk of the tree, so
 *  correlated assets end up adjacent. */
function seriate(node) {
  if (node.leaf != null) return [node.leaf];
  return [...seriate(node.left), ...seriate(node.right)];
}

function clusterVar(cov, items) {
  // inverse-variance weights within the sub-cluster, then w' Σ w
  const iv = items.map((i) => 1 / cov[i][i]);
  const s = iv.reduce((a, b) => a + b, 0);
  const w = iv.map((x) => x / s);
  let v = 0;
  for (let a = 0; a < items.length; a++)
    for (let b = 0; b < items.length; b++)
      v += w[a] * cov[items[a]][items[b]] * w[b];
  return v;
}

/**
 * Hierarchical Risk Parity weights.
 * @param {Object<string, number[]>} returnsBySym  return series per symbol
 * @returns {{weights: Object<string,number>, order: string[], corr: number[][]}}
 */
export function hrpWeights(returnsBySym) {
  const syms = Object.keys(returnsBySym);
  if (syms.length === 0) return { weights: {}, order: [], corr: [] };
  if (syms.length === 1) return { weights: { [syms[0]]: 1 }, order: syms, corr: [[1]] };

  const { syms: aligned, rows } = alignReturns(returnsBySym);
  const { cov, corr } = covCorr(rows);
  const order = seriate(clusterTree(corr)); // indices into `aligned`

  // Recursive bisection: split each cluster in half, tilt weight toward the
  // lower-variance half (inverse-variance across sub-cluster risk).
  const w = new Array(aligned.length).fill(1);
  let clusters = [order];
  while (clusters.length) {
    const next = [];
    for (const c of clusters) {
      if (c.length <= 1) continue;
      const mid = Math.floor(c.length / 2);
      const c0 = c.slice(0, mid), c1 = c.slice(mid);
      const v0 = clusterVar(cov, c0), v1 = clusterVar(cov, c1);
      const alpha = 1 - v0 / (v0 + v1); // more weight to the calmer side
      for (const i of c0) w[i] *= alpha;
      for (const i of c1) w[i] *= 1 - alpha;
      next.push(c0, c1);
    }
    clusters = next;
  }
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const weights = {};
  aligned.forEach((_, i) => { weights[aligned[i]] = w[i] / total; });
  return { weights, order: order.map((i) => aligned[i]), corr };
}
