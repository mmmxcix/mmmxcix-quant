import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the module at a throwaway flag BEFORE importing it — otherwise this
// file would pause the live agent fleet every time the suite runs.
process.env.MMMXCIX_PAUSE_FILE = join(tmpdir(), `mmmxcix-pause-test-${process.pid}`);

const {
  PAUSE_FILE, isPaused, setPaused, pauseInfo, gpuBusy,
  GPU_BUSY_UTIL, GPU_BUSY_VRAM_MB,
} = await import("../scripts/gaming-mode.mjs");

test("the tests are pointed at a throwaway flag, not the live one", () => {
  assert.notEqual(PAUSE_FILE, join(process.env.USERPROFILE || process.env.HOME || "", ".mmmxcix-paused"));
});

// The pause switch is the one thing here the user reaches for while a game is
// already running, so its failure modes matter more than its happy path: a
// pause that does not stick, or a resume that does not come back, is worse than
// no switch at all.

const clean = () => { if (existsSync(PAUSE_FILE)) unlinkSync(PAUSE_FILE); };
afterEach(clean);

test("pausing and resuming round-trips", () => {
  clean();
  assert.equal(isPaused(), false);
  setPaused(true, "gaming");
  assert.equal(isPaused(), true);
  setPaused(false);
  assert.equal(isPaused(), false, "resume must actually remove the flag");
});

test("resuming when not paused is not an error", () => {
  clean();
  setPaused(false);        // would throw on unlink of a missing file
  assert.equal(isPaused(), false);
});

test("pausing twice keeps it paused rather than toggling", () => {
  clean();
  setPaused(true, "gaming");
  setPaused(true, "gaming");
  assert.equal(isPaused(), true, "a second pause must not resume the fleet");
});

test("the flag records when and why, and survives a corrupt file", () => {
  clean();
  assert.equal(pauseInfo(), null);
  setPaused(true, "gaming");
  const info = pauseInfo();
  assert.equal(info.reason, "gaming");
  assert.ok(info.at > 0);
  // A half-written file must still read as PAUSED — the safe direction. Treating
  // unparseable state as "running" would restart the agents mid-game.
  writeFileSync(PAUSE_FILE, "{not json", "utf8");
  assert.equal(isPaused(), true);
  assert.equal(pauseInfo().reason, "unknown");
});

test("gpuBusy reports a usable verdict on this machine", () => {
  const g = gpuBusy();
  assert.equal(typeof g.busy, "boolean");
  assert.equal(typeof g.reason, "string");
  if (Number.isFinite(g.util)) {
    // When nvidia-smi answered, the verdict must follow its own thresholds.
    assert.equal(g.busy, g.util >= GPU_BUSY_UTIL || g.usedMb >= GPU_BUSY_VRAM_MB);
  } else {
    // No GPU / no driver: must fail OPEN. Reporting "busy" forever would leave
    // Kronos permanently disabled on a machine that simply cannot be measured.
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
