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

import { fork, spawn } from "node:child_process";
import { isPaused, gpuBusy, readState, setPaused, reconcile } from "./gaming-mode.mjs";
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
  if (isPaused()) {
    console.log(`[${stamp()}] ${name}: skipped — fleet paused`);
    return;
  }
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
const persistent = new Map();   // name -> { file, child }

function runPersistent(name, file) {
  persistent.set(name, { file, child: null });
  if (isPaused()) {
    console.log(`[${stamp()}] ${name}: not started — fleet paused`);
    return;
  }
  let fd;
  try { fd = openSync(logFor(name), "a"); } catch { fd = "ignore"; }
  const child = fork(here(file), [], { stdio: ["ignore", fd, fd, "ipc"], windowsHide: true, env: process.env });
  persistent.set(name, { file, child });
  console.log(`[${stamp()}] ${name}: started (pid ${child.pid}, persistent)`);
  const restart = (why) => {
    const entry = persistent.get(name);
    if (entry) entry.child = null;
    // A pause kills these on purpose — do not fight it by restarting.
    if (isPaused()) {
      console.log(`[${stamp()}] ${name}: ${why} — staying down while paused`);
      return;
    }
    console.log(`[${stamp()}] ${name}: ${why} — restarting in 10s`);
    setTimeout(() => runPersistent(name, file), 10_000);
  };
  child.on("exit", (code) => restart(`exited (${code})`));
  child.on("error", (e) => restart(`error ${e.message}`));
}

// Sync with the switch on /arena. The site is polled rather than pushed to,
// because this machine sits behind a router and has no inbound address. Whoever
// decided LAST wins (see reconcile), so a local double-click is not undone by
// the next poll, and the site is corrected to show what is actually true here.
const ARENA_API = process.env.ARENA_API || "https://quant.mmmxcix.com/api/arena";
const FLEET_TOKEN = process.env.LAB_TOKEN || process.env.DEV_ACCESS_TOKEN || "";

let lastSwitchPush = 0;
const SWITCH_HEARTBEAT_MS = 4 * 60_000;

async function syncSwitch() {
  let remote = null;
  try {
    const r = await fetch(`${ARENA_API}?what=control`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) remote = (await r.json())?.control ?? null;
  } catch { return; }            // offline: local state stands, which is correct
  const local = readState();
  const d = reconcile(local, remote);
  if (d.apply) {
    setPaused(d.paused, "web", remote.at);
    console.log(`[${stamp()}] switch: ${d.paused ? "PAUSE" : "RESUME"} requested from the website`);
    return;                       // the pause watcher below acts on it next tick
  }
  // Report even when nothing changed, at a slow beat: without it the site can
  // never tell "running" from "this machine is off", because a fleet that
  // agrees with the switch has nothing to say and would stay silent forever.
  const heartbeatDue = Date.now() - lastSwitchPush > SWITCH_HEARTBEAT_MS;
  if ((d.push || heartbeatDue) && FLEET_TOKEN) {
    lastSwitchPush = Date.now();
    try {
      await fetch(ARENA_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: FLEET_TOKEN, controlState: local }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { lastSwitchPush = 0; }   // failed — retry on the next poll
  }
}
setInterval(syncSwitch, 30_000);
syncSwitch();

// Poll the pause flag so it takes effect WITHOUT restarting the daemon: a file
// can be toggled by a shortcut mid-game, an env var cannot.
let wasPaused = isPaused();
setInterval(() => {
  const now = isPaused();
  if (now === wasPaused) return;
  wasPaused = now;
  if (now) {
    console.log(`[${stamp()}] PAUSED — stopping persistent agents`);
    for (const [name, e] of persistent) {
      if (e.child) { try { e.child.kill(); } catch { /* already gone */ } console.log(`[${stamp()}] ${name}: stopped`); }
    }
  } else {
    console.log(`[${stamp()}] RESUMED — restarting persistent agents`);
    for (const [name, e] of [...persistent]) if (!e.child) runPersistent(name, e.file);
  }
}, 30_000);

/** Run a PYTHON script on a schedule. fork() only works for node, so this is a
 *  plain spawn — but with windowsHide AND stdio pointed at a log file, so no
 *  console is inherited or created and nothing can flash. */
function runPython(name, args) {
  if (isPaused()) {
    console.log(`[${stamp()}] ${name}: skipped — fleet paused`);
    return;
  }
  if (running.has(name)) {
    console.log(`[${stamp()}] ${name}: previous run still going — skipped`);
    return;
  }
  running.add(name);
  let fd;
  try { fd = openSync(logFor(name), "a"); } catch { fd = "ignore"; }
  const child = spawn("python", args, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: process.env,
  });
  console.log(`[${stamp()}] ${name}: started (pid ${child.pid})`);
  child.on("exit", (code) => { running.delete(name); console.log(`[${stamp()}] ${name}: finished (exit ${code})`); });
  child.on("error", (e) => { running.delete(name); console.error(`[${stamp()}] ${name}: failed — ${e.message}`); });
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

// SEC Form 4 ingest (see docs/INSIDER.md): the daily index → the new insider
// filings → a cluster pass over a trailing window. 05:00, after the SEC's
// overnight dissemination and before the US open. It runs here rather than in a
// Worker because it is ~1,000 requests paced at 8/s against SEC's courtesy limit,
// and because SEC serves a 403 to anything without a real User-Agent.
// Opt out with INSIDER_AGENT=0.
if (process.env.INSIDER_AGENT !== "0") atHours([5], () => runAgent("insider", "insider-agent.mjs"));

// Statements by important people (see docs/STATEMENTS.md): the OSINT squawk and
// the RSS pool → who said what → which basket the mechanism points at. Every 30
// minutes, because `t.me/s/` only pages back as far as a channel's own history
// and a statement that scrolls off unstored is not recoverable later.
// It runs here rather than in a Worker because the second classifier is the
// LOCAL OmniRoute router. Opt out with STATEMENTS_AGENT=0.
if (process.env.STATEMENTS_AGENT !== "0") everyMinutes(30, () => runAgent("statements", "statements-agent.mjs"));

// Native backtest executor: a persistent poller that runs C++/q/native-Python/JS
// backtests the browser submits, and pushes results back. Opt out with
// LAB_EXECUTOR=0 (e.g. on a machine without the toolchains).
if (process.env.LAB_EXECUTOR !== "0") runPersistent("executor", "executor-agent.mjs");

// Arena: a persistent websocket client on the Binance book, paper-trading the
// order-book strategies that cannot be backtested (see src/lib/arena.js). It
// belongs here rather than in its own autostart entry for the reason at the top
// of this file — forked, so it never creates a console to be hijacked. It also
// needs to run CONTINUOUSLY: the micro-price model needs ~25 minutes of live
// book before it can be fitted at all, so a scheduled pass would never get one.
// Opt out with ARENA_AGENT=0.
if (process.env.ARENA_AGENT !== "0") runPersistent("arena", "arena-agent.mjs");

// Telegram OSINT (MTProto): a persistent 60s poller of the fast market-ticker
// channels. /api/telegram already serves the keyless t.me/s/ scrape on its own,
// so this is a strict upgrade rather than a dependency — MTProto also reads the
// image-caption squawk channels the preview page cannot show, and its push wins
// on the endpoint while it is fresh.
//
// Started ONLY when a session exists (scripts/telegram-auth.mjs writes one).
// Without the credentials the poller exits immediately, and a persistent agent
// that exits immediately is a restart loop every 10 seconds — so it stays down
// and says why.
if (process.env.TELEGRAM_AGENT !== "0") {
  if (process.env.TG_API_ID && process.env.TG_API_HASH && process.env.TG_SESSION) {
    runPersistent("telegram", "telegram-mtproto.mjs");
  } else {
    console.log(`[${stamp()}] telegram: not started — no TG_SESSION (run scripts/telegram-auth.mjs once). The t.me/s/ scrape keeps serving /api/telegram meanwhile.`);
  }
}

// Kronos: forecasts crypto 24h ahead and grades the PREVIOUS forecasts against
// a random walk. Python, so it is a scheduled pass rather than a fork — see
// runPython below for why that still cannot pop a window.
// If the GPU is busy — a game, a render — take the grading pass only. That half
// is arithmetic over forecasts already on disk and needs no GPU, so the
// scoreboard still fills while the card is left alone. The forecast catches up
// at the next slot.
if (process.env.KRONOS_AGENT !== "0") {
  atHours([1, 13], () => {
    const g = gpuBusy();
    if (g.busy) {
      console.log(`[${stamp()}] kronos: forecast skipped — ${g.reason}; grading only`);
      runPython("kronos", ["scripts/kronos/forecast.py", "--score-only"]);
    } else {
      runPython("kronos", ["scripts/kronos/forecast.py"]);
    }
  });
}

console.log(`[${stamp()}] agent-daemon running — lab/15min · statements/30min · research/04:00 · revalidate/08,11,14,17,20 · discover/12:00 · retest/06,18 · mine/07 · insider/05 · executor/persistent · arena/persistent · telegram/persistent · kronos/01,13`);
runAgent("lab", "lab-agent.mjs"); // one immediate pass so a restart isn't idle for 15 min
