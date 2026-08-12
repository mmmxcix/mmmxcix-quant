import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the module at a throwaway flag BEFORE importing it — otherwise this
// file would pause the live agent fleet every time the suite runs.
process.env.MMMXCIX_PAUSE_FILE = join(tmpdir(), `mmmxcix-pause-test-${process.pid}`);

const {
  PAUSE_FILE, isPaused, setPaused, readState, clearState, reconcile, gpuBusy,
  GPU_BUSY_UTIL, GPU_BUSY_VRAM_MB,
} = await import("../scripts/gaming-mode.mjs");

// The pause switch is the one thing here reached for while a game is already
// running, so its failure modes matter more than its happy path: a pause that
// does not stick, or a resume that does not come back, is worse than no switch.
// And it now has TWO owners — this machine and the website — so the rule for
// which one wins is the part most likely to go quietly wrong.

afterEach(clearState);

test("the tests are pointed at a throwaway flag, not the live one", () => {
  assert.notEqual(PAUSE_FILE, join(process.env.USERPROFILE || process.env.HOME || "", ".mmmxcix-paused"));
});

test("pausing and resuming round-trips", () => {
  clearState();
  assert.equal(isPaused(), false);
  setPaused(true, "local");
  assert.equal(isPaused(), true);
  setPaused(false, "local");
  assert.equal(isPaused(), false, "resume must actually clear it");
});

test("both states carry a timestamp, not just the paused one", () => {
  // This is what makes local-vs-web resolvable. If "running" had no time, the
  // website's stale opinion would outrank a resume someone just performed here.
  setPaused(false, "local");
  const s = readState();
  assert.equal(s.paused, false);
  assert.ok(s.at > 0, "a resume must record when it happened");
  assert.equal(s.source, "local");
});

test("a missing flag reads as running, but from the beginning of time", () => {
  clearState();
  const s = readState();
  assert.equal(s.paused, false);
  assert.equal(s.at, 0, "a fresh machine must never out-rank a real decision");
});

test("a corrupt flag reads as PAUSED — the safe direction", () => {
  writeFileSync(PAUSE_FILE, "{not json", "utf8");
  assert.equal(isPaused(), true, "unparseable state must not restart agents mid-game");
  assert.equal(readState().source, "corrupt");
});

test("pausing twice keeps it paused rather than toggling", () => {
  clearState();
  setPaused(true, "local");
  setPaused(true, "local");
  assert.equal(isPaused(), true);
});

// ── local vs website ────────────────────────────────────────────────────────

test("a newer decision from the website is applied here", () => {
  const local = { paused: false, at: 1000 };
  const d = reconcile(local, { paused: true, at: 2000 });
  assert.equal(d.apply, true);
  assert.equal(d.paused, true);
});

test("a LOCAL toggle is not undone by the next poll", () => {
  // The regression that would make the local double-click useless: someone
  // pauses by hand, and 30 seconds later the site's older state resumes it.
  const local = { paused: true, at: 5000 };
  const d = reconcile(local, { paused: false, at: 1000 });
  assert.equal(d.apply, false, "the older remote state must not win");
  assert.equal(d.paused, true);
  assert.equal(d.push, true, "…and the site must be corrected to match");
});

test("when the two already agree, nothing is applied and nothing is pushed", () => {
  const d = reconcile({ paused: true, at: 5000 }, { paused: true, at: 5000 });
  assert.equal(d.apply, false);
  assert.equal(d.push, false, "an idle fleet must not write to the API every 30s");
});

test("an unreachable site leaves the local state alone", () => {
  const d = reconcile({ paused: true, at: 5000 }, null);
  assert.equal(d.apply, false);
  assert.equal(d.paused, true);
});

test("a same-time remote change does not flip the switch", () => {
  // Ties keep local, so a clock that agrees to the millisecond cannot cause a
  // flip nobody asked for.
  const d = reconcile({ paused: false, at: 7000 }, { paused: true, at: 7000 });
  assert.equal(d.apply, false);
});

// ── GPU ─────────────────────────────────────────────────────────────────────

test("gpuBusy reports a usable verdict on this machine", () => {
  const g = gpuBusy();
  assert.equal(typeof g.busy, "boolean");
  assert.equal(typeof g.reason, "string");
  if (Number.isFinite(g.util)) {
    assert.equal(g.busy, g.util >= GPU_BUSY_UTIL || g.usedMb >= GPU_BUSY_VRAM_MB);
  } else {
    // No GPU / no driver: must fail OPEN. Reporting "busy" forever would leave
    // Kronos permanently disabled on a machine that cannot be measured.
    assert.equal(g.busy, false, "an unreadable GPU must not disable the forecast");
  }
});

test("the thresholds leave room for an ordinary desktop", () => {
  // A browser and a couple of apps sit around 3-4 GB of VRAM on this card; the
  // bar has to be above that or Kronos would never run at all.
  assert.ok(GPU_BUSY_VRAM_MB >= 5000, "too low — an idle desktop would count as busy");
  assert.ok(GPU_BUSY_VRAM_MB <= 12000, "too high — a game would not be noticed");
  assert.ok(GPU_BUSY_UTIL >= 20 && GPU_BUSY_UTIL <= 60);
});
