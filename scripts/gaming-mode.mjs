// gaming-mode.mjs — pause the local agent fleet, and keep it off the GPU while
// something else is using it.
//
// THREE WAYS IN, and the first one needs no action at all:
//
//  1. AUTOMATIC. Before Kronos runs — the only agent that touches the GPU — the
//     daemon asks nvidia-smi whether the card is busy. If it is, the forecast is
//     skipped and only the GRADING pass runs, which is arithmetic over numbers
//     already on disk. Nothing to remember, nothing to switch back on.
//
//  2. LOCAL. `gaming-mode.cmd` (double-click) or `npm run gaming:on|off`.
//
//  3. REMOTE. The admin-only switch on /arena. The daemon polls it, so a flip
//     from the web reaches this machine within ~30s.
//
// STATE IS ONE TIMESTAMPED FILE, and it is written for BOTH states rather than
// existing-or-not. That is what lets local and remote coexist: each side knows
// when the other last changed its mind, so the newer decision wins instead of
// the poll loop silently undoing a switch someone just pressed by hand.
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

/**
 * The fleet's state, always with the moment it was decided and by whom.
 * A missing file means "running, forever ago" — a fresh machine must not
 * out-rank a real decision made from the web.
 */
export function readState() {
  if (!existsSync(PAUSE_FILE)) return { paused: false, at: 0, source: "default" };
  let raw;
  try { raw = readFileSync(PAUSE_FILE, "utf8"); }
  catch { return { paused: true, at: 0, source: "unreadable" }; }
  try {
    const s = JSON.parse(raw);
    return {
      paused: !!s.paused,
      at: Number.isFinite(s.at) ? s.at : 0,
      source: typeof s.source === "string" ? s.source : "unknown",
    };
  } catch {
    // A half-written file reads as PAUSED — the safe direction. Treating
    // unparseable state as "running" would restart the agents mid-game.
    return { paused: true, at: 0, source: "corrupt" };
  }
}

export function isPaused() {
  return readState().paused;
}

export function setPaused(on, source = "local", at = Date.now()) {
  writeFileSync(PAUSE_FILE, JSON.stringify({ paused: !!on, at, source }), "utf8");
}

/** Remove the file entirely — used only by tests and a full reset. */
export function clearState() {
  if (existsSync(PAUSE_FILE)) unlinkSync(PAUSE_FILE);
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

/**
 * Reconcile the local state with the one the website holds. Whichever side
 * decided MORE RECENTLY wins; ties keep the local state, so a poll can never
 * flip a switch nobody touched.
 *
 * Returns what the caller should do: { apply: bool, paused, push: bool }.
 * Pure, so the precedence rule is testable without a network or a daemon.
 */
export function reconcile(local, remote) {
  const r = remote && Number.isFinite(remote.at) ? remote : null;
  if (!r) return { apply: false, paused: local.paused, push: true };
  if (r.at > local.at && r.paused !== local.paused) {
    return { apply: true, paused: r.paused, push: false };
  }
  // Local is newer, or they already agree — make sure the site shows the truth.
  return { apply: false, paused: local.paused, push: r.paused !== local.paused || r.at < local.at };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function status() {
  const s = readState();
  const g = gpuBusy();
  if (s.paused) {
    const since = s.at ? new Date(s.at).toLocaleString() : "unknown time";
    console.log(`PAUSED since ${since} (set ${s.source})`);
    console.log("Everything is stopped. `npm run gaming:off`, or the switch on /arena.");
  } else {
    console.log("RUNNING — the fleet is active.");
    console.log(`Kronos will ${g.busy ? "SKIP its next forecast" : "run normally"}: ${g.reason}`);
  }
}

if (process.argv[1]?.endsWith("gaming-mode.mjs")) {
  const cmd = (process.argv[2] || "status").toLowerCase();
  if (cmd === "on" || cmd === "pause") {
    setPaused(true, "local");
    console.log("Paused. The daemon stops its agents within ~30s; nothing will start until you turn it off.");
  } else if (cmd === "off" || cmd === "resume") {
    setPaused(false, "local");
    console.log("Resumed. The daemon picks the agents back up within ~30s.");
  } else if (cmd === "toggle") {
    const next = !isPaused();
    setPaused(next, "local");
    console.log(next ? "Paused." : "Resumed.");
  } else if (cmd === "status") {
    status();
  } else {
    console.log("usage: node scripts/gaming-mode.mjs [on|off|toggle|status]");
    process.exit(1);
  }
}
