import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The snapshot contract (docs/STATIC_FIRST_AUDIT.md §5, docs/BRIEFING.md):
// every snapshot carries source + asOf + status, the manifest lists exactly the
// files that exist, and the committed tree stays small (repo size guard).

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const COMMITTED = "public/snapshots";
const R2 = "snapshots/r2";
const manifest = JSON.parse(readFileSync("snapshots/manifest.json", "utf8"));
const STATUSES = ["live", "stale", "down", "stub"];

test("every snapshot file carries the envelope", () => {
  for (const f of [...walk(COMMITTED), ...walk(R2)]) {
    const s = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(s.schema, "mmmxcix.snapshot/v1", f);
    assert.equal(typeof s.source, "string", `${f}: source`);
    assert.ok(s.asOf === null || Number.isFinite(s.asOf), `${f}: asOf`);
    assert.ok(STATUSES.includes(s.status), `${f}: status`);
    assert.ok("data" in s, `${f}: data`);
    if (s.status === "live" || s.status === "stale") assert.ok(Number.isFinite(s.asOf), `${f}: data without asOf`);
  }
});

test("briefing: every panel carries its own source/asOf/status", () => {
  const b = JSON.parse(readFileSync(join(R2, "briefing/YYYY-MM-DD.json"), "utf8"));
  for (const [name, p] of Object.entries(b.panels)) {
    for (const k of ["source", "asOf", "status", "data"]) assert.ok(k in p, `panel ${name}: ${k}`);
  }
});

test("manifest lists exactly the files that exist", () => {
  const listed = manifest.paths.map((p) => (p.store === "committed" ? join(COMMITTED, p.path) : join(R2, p.path))).sort();
  const onDisk = [...walk(COMMITTED), ...walk(R2)].sort();
  assert.deepEqual(listed, onDisk);
});

test("repo size guard: committed snapshots stay small and are not per-day history", () => {
  const files = walk(COMMITTED);
  const total = files.reduce((s, f) => s + statSync(f).size, 0);
  assert.ok(total <= 50 * 1024 * 1024, `public/snapshots is ${(total / 1048576).toFixed(1)} MB (budget 50 MB)`);
  for (const f of files) {
    assert.ok(statSync(f).size <= 2 * 1024 * 1024, `${f} exceeds 2 MB`);
    // Daily history belongs in R2, not in git — a dated filename here is a leak.
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(f), `${f}: dated file in the repo — per-day history goes to R2`);
  }
  // R2 templates are templates: they never carry data in the repo.
  for (const f of walk(R2)) assert.equal(JSON.parse(readFileSync(f, "utf8")).data, null, `${f}: R2 template with data`);
});

test("repo size guard: public/ stays well under the Pages file-count limit", (t) => {
  // Pages Free rejects a deployment over 20,000 files. Daily snapshots grow the
  // COUNT long before the bytes, so this counts files. The authoritative check
  // on the built output is scripts/check-deploy-size.mjs (warns at 15,000).
  const n = walk("public").length;
  if (n >= 10_000) t.diagnostic(`public/ has ${n} files — check-deploy-size warns at 15,000, Pages rejects at 20,000`);
  assert.ok(n < 15_000, `public/ has ${n} files; per-day snapshots belong in R2`);
});
