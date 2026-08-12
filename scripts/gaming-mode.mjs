// gaming-mode.mjs — pause the local agent fleet, and keep it off the GPU while
// something else is using it.
//
// TWO MECHANISMS, and the first one is the important one:
//
//  1. AUTOMATIC. Before Kronos runs — the only agent that touches the GPU — the
//     daemon asks nvidia-smi whether the card is busy. If it is, the forecast is
//     skipped and only the GRADING pass runs, which is pure arithmetic over
//     numbers already on disk. Nothing to remember, nothing to switch back on.
//
//  2. MANUAL. A pause file. While it exists the daemon runs nothing and stops
//     its long-running children; deleting it brings them straight back. A file
//     rather than an env var so it takes effect WITHOUT restarting the daemon,
//     and survives a reboot in whichever state you left it.
//
// What this is actually protecting: measured on this machine the whole fleet is
// ~530 MB of RAM and a few CPU-seconds an hour, and only Kronos ever allocates
// VRAM. So pausing is about the compile spikes (the executor builds C++/q) and
// about being certain, not about reclaiming much.

import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// Overridable so the tests never touch the real flag. Without this, `npm test`
// would pause the live fleet for the length of a run — and leave it paused for
// good if a test failed before its cleanup.
export const PAUSE_FILE = process.env.MMMXCIX_PAUSE_FILE || join(homedir(), ".mmmxcix-paused");

/** Is the fleet manually paused? */
export function isPaused() {
  return existsSync(PAUSE_FILE);
}

/** When it was paused, and why, for the status line. */
export function pauseInfo() {
  if (!isPaused()) return null;
  try { return JSON.parse(readFileSync(PAUSE_FILE, "utf8")); }
  catch { return { at: null, reason: "unknown" }; }
}

export function setPaused(on, reason = "manual") {
  if (on) writeFileSync(PAUSE_FILE, JSON.stringify({ at: Date.now(), reason }), "utf8");
  else if (existsSync(PAUSE_FILE)) unlinkSync(PAUSE_FILE);
}

// A game does not usually show up as a CUDA "compute app" — it uses the
// graphics pipeline — so the reliable signal is the card's own utilisation and
// how much memory is already committed, not the process list.
export const GPU_BUSY_UTIL = 35;      // percent
export const GPU_BUSY_VRAM_MB = 6000; // of 16 GB; a desktop + browsers sit well under this

/**
 * Is something else leaning on the GPU right now?
 * Returns { busy, util, usedMb, reason } — and busy:false when nvidia-smi is
 * missing, because "cannot tell" must not silently disable the forecast forever.
 */
export function gpuBusy() {
  let out;
  try {
    out = spawnSync("nvidia-smi",
      ["--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 5000, windowsHide: true });
  } catch {
    return { busy: false, reason: "nvidia-smi unavailable" };
  }
  if (out.error || out.status !== 0 || !out.stdout) {
    return { busy: false, reason: "nvidia-smi unavailable" };
  }
  const [utilRaw, memRaw] = out.stdout.trim().split("\n")[0].split(",");
  const util = Number(utilRaw), usedMb = Number(memRaw);
  if (!Number.isFinite(util) || !Number.isFinite(usedMb)) {
    return { busy: false, reason: "unreadable nvidia-smi output" };
  }
  const busy = util >= GPU_BUSY_UTIL || usedMb >= GPU_BUSY_VRAM_MB;
  return {
    busy, util, usedMb,
    reason: busy ? `GPU at ${util}% with ${usedMb} MiB in use` : `GPU idle (${util}%, ${usedMb} MiB)`,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function status() {
  const p = pauseInfo();
  const g = gpuBusy();
  if (p) {
    const since = p.at ? new Date(p.at).toLocaleString() : "unknown time";
    console.log(`PAUSED since ${since} (${p.reason})`);
    console.log("Everything is stopped. Run `npm run gaming:off` to bring it back.");
  } else {
    console.log("RUNNING — the fleet is active.");
    console.log(`Kronos will ${g.busy ? "SKIP its next forecast" : "run normally"}: ${g.reason}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("gaming-mode.mjs")) {
  const cmd = (process.argv[2] || "status").toLowerCase();
  if (cmd === "on" || cmd === "pause") {
    setPaused(true, "gaming");
    console.log("Paused. The daemon stops its agents within ~30s; nothing will start until you turn it off.");
  } else if (cmd === "off" || cmd === "resume") {
    setPaused(false);
    console.log("Resumed. The daemon picks the agents back up within ~30s.");
  } else if (cmd === "status") {
    status();
  } else {
    console.log("usage: node scripts/gaming-mode.mjs [on|off|status]");
    process.exit(1);
  }
}
