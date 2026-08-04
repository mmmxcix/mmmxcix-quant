// agent-daemon.mjs — ONE persistent, windowless scheduler for all Cortex agents.
//
// WHY THIS EXISTS. Windows 11's default terminal hijacks every newly CREATED
// console and shows it in a window, ignoring the hide flag of whoever started the
// process. So anything that spawns `node` every 15 minutes (a Scheduled Task, an
// n8n Execute Command, a detached spawn) flashes a terminal, no matter how it is
// hidden. The fix is to stop creating processes on a schedule: this daemon starts
// ONCE (hidden), stays running, and launches the agents with child_process.fork(),
// which INHERITS the parent's console instead of allocating a new one. No new
// console is ever created, so nothing can be hijacked.
//
// Schedules (same cadence as the Scheduled Tasks it replaces):
//   lab-agent        every 15 min
//   research-agent   daily 04:00   (lab-agent also triggers it in always-on mode)
//   revalidate-agent 08,11,14,17,20
//   discover-sources daily 12:00
// Each run's output is appended to ~/.mmmxcix-<name>.log. One instance per agent
// at a time — an overrun is skipped, not stacked.

import { fork } from "node:child_process";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (f) => fileURLToPath(new URL(`./${f}`, import.meta.url));
const logFor = (name) => join(homedir(), `.mmmxcix-${name}.log`);
const stamp = () => new Date().toISOString();

const running = new Set();

/** Run an agent script as a forked child (no new console → never a window). */
function runAgent(name, file) {
  if (running.has(name)) {
    console.log(`[${stamp()}] ${name}: previous run still going — skipped`);
    return;
  }
  running.add(name);
  let fd;
  try { fd = openSync(logFor(name), "a"); } catch { fd = "ignore"; }
  const child = fork(here(file), [], {
    stdio: ["ignore", fd, fd, "ipc"], // stdout/stderr → log file (not an inherited console)
    windowsHide: true,                // …so Windows must NOT allocate a new visible console
    env: process.env,                 // carries LAB_TOKEN, LAB_LLM_URL, …
  });
  console.log(`[${stamp()}] ${name}: started (pid ${child.pid})`);
  child.on("exit", (code) => {
    running.delete(name);
    console.log(`[${stamp()}] ${name}: finished (exit ${code})`);
  });
  child.on("error", (e) => {
    running.delete(name);
    console.error(`[${stamp()}] ${name}: failed — ${e.message}`);
  });
}

/** Run a PERSISTENT agent (a poller, not a scheduled pass): fork it and re-fork
 *  if it ever exits, with a short backoff. Used for the native backtest executor. */
function runPersistent(name, file) {
  let fd;
  try { fd = openSync(logFor(name), "a"); } catch { fd = "ignore"; }
  const child = fork(here(file), [], { stdio: ["ignore", fd, fd, "ipc"], windowsHide: true, env: process.env });
  console.log(`[${stamp()}] ${name}: started (pid ${child.pid}, persistent)`);
  const restart = (why) => {
    console.log(`[${stamp()}] ${name}: ${why} — restarting in 10s`);
    setTimeout(() => runPersistent(name, file), 10_000);
  };
  child.on("exit", (code) => restart(`exited (${code})`));
  child.on("error", (e) => restart(`error ${e.message}`));
}

// ── schedule helpers ────────────────────────────────────────────────────────
const MIN = 60_000;

/** Fire `fn` every `minutes`, aligned to the wall clock (not to start time). */
function everyMinutes(minutes, fn) {
  const period = minutes * MIN;
  const tick = () => { fn(); setTimeout(tick, period - (Date.now() % period)); };
  setTimeout(tick, period - (Date.now() % period));
}

/** Fire `fn` at the given local hours (minute 0), once per hour boundary. */
function atHours(hours, fn) {
  const set = new Set(hours);
  let lastFired = -1;
  setInterval(() => {
    const d = new Date();
    const key = d.getFullYear() * 1e6 + (d.getMonth() + 1) * 1e4 + d.getDate() * 100 + d.getHours();
    if (set.has(d.getHours()) && d.getMinutes() < 5 && key !== lastFired) { lastFired = key; fn(); }
  }, 60 * MIN / 12); // check every 5 min
}

// ── wire the schedules ──────────────────────────────────────────────────────
everyMinutes(15, () => runAgent("lab", "lab-agent.mjs"));
atHours([4], () => runAgent("research", "research-agent.mjs"));
atHours([8, 11, 14, 17, 20], () => runAgent("revalidate", "revalidate-agent.mjs"));
atHours([12], () => runAgent("discover", "discover-sources.mjs"));
// Auto-progression: re-test the whole library and re-file each strategy's stage
// (advance / improve / bury). Twice daily, offset from the research passes.
atHours([6, 18], () => runAgent("retest", "retest-library.mjs"));
// Library mining: probe promising builder strategies' parameter neighbourhoods
// and file genuinely-better variants. Once daily, after the morning re-test.
atHours([7], () => runAgent("mine", "mine-library.mjs"));

// Native backtest executor: a persistent poller that runs C++/q/native-Python/JS
// backtests the browser submits, and pushes results back. Opt out with
// LAB_EXECUTOR=0 (e.g. on a machine without the toolchains).
if (process.env.LAB_EXECUTOR !== "0") runPersistent("executor", "executor-agent.mjs");

console.log(`[${stamp()}] agent-daemon running — lab/15min · research/04:00 · revalidate/08,11,14,17,20 · discover/12:00 · retest/06,18 · mine/07 · executor/persistent`);
runAgent("lab", "lab-agent.mjs"); // one immediate pass so a restart isn't idle for 15 min
