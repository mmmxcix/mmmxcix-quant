#!/usr/bin/env node
// check-deploy-size.mjs — guard the Cloudflare Pages deployment limits on the
// BUILT output (dist/), the thing that is actually uploaded.
//
//   npm run build && node scripts/check-deploy-size.mjs [dir]
//
// Pages Free: max 20,000 files per deployment, max 25 MiB per file. Daily
// snapshots will hit the file count long before they hit any byte budget, so
// this warns at 15,000 and fails at 20,000. In GitHub Actions the warning is
// emitted as a ::warning:: annotation so it shows up on the PR.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2] || "dist";
const WARN_FILES = 15_000;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

let files;
try { files = walk(DIR); } catch { console.error(`${DIR}/ not found — run the build first.`); process.exit(2); }

const total = files.reduce((s, f) => s + statSync(f).size, 0);
const big = files.filter((f) => statSync(f).size > MAX_FILE_BYTES);
const ci = !!process.env.GITHUB_ACTIONS;
console.log(`${DIR}/: ${files.length} files, ${(total / 1048576).toFixed(1)} MB (limits: ${MAX_FILES} files, 25 MiB per file)`);

let fail = false;
if (files.length >= MAX_FILES) {
  console.error(`${ci ? "::error::" : "ERROR: "}${files.length} files — at or over the Pages limit of ${MAX_FILES}. The deploy will be rejected.`);
  fail = true;
} else if (files.length >= WARN_FILES) {
  console.warn(`${ci ? "::warning::" : "WARNING: "}${files.length} files — past ${WARN_FILES}, approaching the Pages limit of ${MAX_FILES}. Move per-day snapshots to R2.`);
}
for (const f of big) {
  console.error(`${ci ? "::error::" : "ERROR: "}${f} is ${(statSync(f).size / 1048576).toFixed(1)} MiB — over the 25 MiB Pages per-file limit.`);
  fail = true;
}
process.exit(fail ? 1 : 0);
