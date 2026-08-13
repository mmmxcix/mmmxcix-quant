// argus-halflife.mjs — let the DATA choose the learning loop's half-life.
//
// The loop weights the whole past equally, so a setup that wins sixty trades and
// then loses sixty straight full-stops still reads positive and is never
// switched off. The fix is exponential decay; the open question is how fast.
//
// This sweeps candidate half-lives through the walk-forward replay and prints
// the out-of-sample edge of each. Run it, read it, and set LAB_ARGUS_HALFLIFE_H
// to the winner — but only if the ledger is long enough for the answer to mean
// anything, which the script checks and tells you.
//
//   node scripts/argus-halflife.mjs            (live ledger)
//   node scripts/argus-halflife.mjs file.json  (a saved snapshot)

import { readFileSync } from "node:fs";
import { walkForward, walkForwardVerdict } from "../src/lib/argus/walkforward.js";

const H = 3600e3;
const CANDIDATES = [
  ["none", 0], ["12h", 12 * H], ["1d", 24 * H], ["2d", 48 * H], ["4d", 96 * H],
  ["7d", 168 * H], ["14d", 336 * H], ["30d", 720 * H], ["90d", 2160 * H],
];

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";

async function ledger() {
  const arg = process.argv[2];
  if (arg) return JSON.parse(readFileSync(arg, "utf8")).ledger;
  const r = await fetch(`${SITE}/api/argus?what=all`);
  return (await r.json()).ledger;
}

const closed = (await ledger()).filter((t) => t.state === "closed");
const span = (Math.max(...closed.map((t) => t.exitAt ?? 0)) - Math.min(...closed.map((t) => t.openedAt ?? 0))) / 864e5;
console.log(`${closed.length} closed trades spanning ${span.toFixed(1)} days\n`);

console.log("half-life   kept              refused           edge     refused%  verdict");
const rows = [];
for (const [label, hl] of CANDIDATES) {
  const wf = walkForward(closed, { warmup: 20, minSample: 20, halfLifeMs: hl });
  const v = walkForwardVerdict(wf);
  rows.push({ label, hl, edge: wf.edgeR, wf });
  console.log(
    `${label.padEnd(11)}n=${String(wf.kept.n).padStart(3)} ${wf.kept.avgR.toFixed(3).padStart(7)}    `
    + `n=${String(wf.refused.n).padStart(3)} ${wf.refused.avgR.toFixed(3).padStart(7)}    `
    + `${wf.edgeR.toFixed(3).padStart(6)}   ${(wf.refusedShare * 100).toFixed(0).padStart(3)}%    `
    + (v.proven ? "ok" : "—"));
}

// A half-life longer than the data decays nothing, so it cannot be distinguished
// from no decay at all — reporting the "best" of those would be reading noise.
const usable = rows.filter((r) => r.hl > 0 && r.hl / 864e5 < span / 2);
console.log("");
if (!usable.length) {
  console.log(`INCONCLUSIVE. Every half-life worth testing is longer than half the ledger's`);
  console.log(`${span.toFixed(1)}-day span, so nothing decays and the rows above are the same`);
  console.log(`result printed nine times. Leave LAB_ARGUS_HALFLIFE_H unset and re-run this`);
  console.log(`once the ledger spans a few weeks.`);
} else {
  const best = usable.reduce((a, b) => (b.edge > a.edge ? b : a));
  const none = rows.find((r) => r.hl === 0);
  console.log(best.edge > none.edge
    ? `Best testable half-life: ${best.label} (edge ${best.edge.toFixed(3)}R vs ${none.edge.toFixed(3)}R undecayed).\n`
      + `Set LAB_ARGUS_HALFLIFE_H=${Math.round(best.hl / H)} — and treat it as provisional until\n`
      + `the ledger is several times longer than the half-life itself.`
    : `No decay wins (${none.edge.toFixed(3)}R). Leave LAB_ARGUS_HALFLIFE_H unset.`);
}
