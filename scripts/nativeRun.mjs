// nativeRun.mjs — run a strategy in its REAL language on the machine (home PC or
// a VPS), then feed the signals into the SAME JS fill engine the whole tool uses,
// so fees, next-open fills and brackets match every other backtest exactly.
//
//   • js     → compileStrategy (Node) — native V8, no browser tab limits
//   • python → Pyodide-in-Node (already used by Cortex; no numpy/pandas install)
//   • cpp    → g++ compiles the strategy + a harness; candles in / signals out
//   • q      → the kdb+/q binary runs the strategy over a table
//
// Missing toolchains are detected and reported (never a crash) so the executor
// can run whatever the box actually has. The strategy contract per language:
//   js/python: the editor's usual signal (+ optional stop/target brackets)
//   cpp:  std::vector<int> signals(const std::vector<Bar>& bars)   // +1/0/-1
//   q:    signals:{[t] ... }  returning one signal per row of t

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
// EVERY spawn here passes windowsHide: true. Without it Windows allocates a
// console for g++/q/the compiled binary and a black window flashes over
// whatever the user is doing — Cortex compiles on a timer, so it flashed at
// random moments and was hard to trace back to this file.
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBacktest, compileStrategy } from "../src/lib/backtest.js";
import { initPy, compilePyStrategy, pyReady } from "./pyRunnerNode.mjs";

const GPP = process.env.LAB_GPP || "g++";
const QBIN = process.env.LAB_Q || "q";

/** Which native toolchains are available on this machine. */
export function detectTools() {
  const has = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: "ignore", timeout: 5000, windowsHide: true }).error == null; } catch { return false; } };
  return {
    node: true,
    python: true,               // Pyodide ships in-process — always available
    cpp: has(GPP, ["--version"]),
    q: has(QBIN, ["--version"]) || has(QBIN, ["-q"]),
  };
}

const candlesCsv = (candles) =>
  candles.map((c) => `${c.open},${c.high},${c.low},${c.close},${c.volume ?? 0}`).join("\n");

// ── C++ ──────────────────────────────────────────────────────────────────────
// The user code defines `struct Bar` + `signals(bars)` (exactly the C++ export).
// We append a main() that reads candle CSV from stdin and prints one signal/line.
// Assemble the full translation unit: headers, a Bar struct (only if the code
// doesn't already define one — the C++ export does, a bare signals() may not),
// the user's code, then the stdin/stdout main().
function cppSource(code) {
  const bar = /struct\s+Bar\b/.test(code) ? "" : "struct Bar { double open, high, low, close, volume; };\n";
  return `#include <vector>\n#include <cmath>\n#include <deque>\n#include <algorithm>\n${bar}${code}\n${CPP_HARNESS}`;
}

const CPP_HARNESS = `
#include <iostream>
#include <string>
#include <sstream>
#include <cstdlib>
int main() {
  std::vector<Bar> bars; std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    std::stringstream ss(line); std::string tok; double v[5] = {0,0,0,0,0}; int i = 0;
    while (std::getline(ss, tok, ',') && i < 5) v[i++] = std::atof(tok.c_str());
    Bar b; b.open=v[0]; b.high=v[1]; b.low=v[2]; b.close=v[3]; b.volume=v[4]; bars.push_back(b);
  }
  std::vector<int> sig = signals(bars);
  for (size_t i = 0; i < sig.size(); ++i) std::cout << sig[i] << "\\n";
  return 0;
}
`;

function cppSignals(code, candles) {
  if (spawnSync(GPP, ["--version"], { timeout: 5000, windowsHide: true }).error) return { toolMissing: "g++" };
  const dir = mkdtempSync(join(tmpdir(), "cppbt-"));
  try {
    const src = join(dir, "strat.cpp");
    const exe = join(dir, process.platform === "win32" ? "strat.exe" : "strat.out");
    writeFileSync(src, cppSource(code));
    const comp = spawnSync(GPP, ["-O2", "-std=c++17", "-o", exe, src], { encoding: "utf8", timeout: 60000, windowsHide: true });
    if (comp.status !== 0) return { error: "compile: " + (comp.stderr || "unknown").split("\n").filter(Boolean).slice(0, 4).join(" | ").slice(0, 400) };
    const run = spawnSync(exe, [], { input: candlesCsv(candles), encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 60000, windowsHide: true });
    if (run.status !== 0) return { error: "runtime: " + (run.stderr || `exit ${run.status}`).slice(0, 300) };
    const sig = run.stdout.trim().split("\n").filter((x) => x !== "").map((x) => parseInt(x, 10) || 0);
    if (sig.length !== candles.length) return { error: `C++ returned ${sig.length} signals for ${candles.length} bars` };
    return { signals: sig };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } }
}

// ── kdb+/q ───────────────────────────────────────────────────────────────────
// The user code defines signals:{[t] ...}. We load the candle CSV into a table t
// and print one signal per row. q must be installed + licensed (free personal ed).
function qSignals(code, candles) {
  if (spawnSync(QBIN, ["-q"], { timeout: 5000, input: "exit 0", windowsHide: true }).error) return { toolMissing: "q" };
  const dir = mkdtempSync(join(tmpdir(), "qbt-"));
  try {
    const csv = join(dir, "candles.csv");
    const script = join(dir, "run.q");
    writeFileSync(csv, "open,high,low,close,volume\n" + candlesCsv(candles) + "\n");
    const q =
      code + "\n" +
      `t:("FFFFF";enlist ",") 0: \`$"${csv.replace(/\\/g, "/")}";\n` +
      "t:`open`high`low`close`volume xcol t;\n" +
      "res:signals[t];\n" +
      "-1 \"\\n\" sv string `int$res;\n" +
      "exit 0;\n";
    writeFileSync(script, q);
    const run = spawnSync(QBIN, [script, "-q"], { encoding: "utf8", timeout: 60000, maxBuffer: 128 * 1024 * 1024, windowsHide: true });
    if (run.status !== 0 && run.status !== null) return { error: "q: " + (run.stderr || run.stdout || `exit ${run.status}`).slice(0, 300) };
    const sig = (run.stdout || "").trim().split("\n").filter((x) => /^-?\d+$/.test(x.trim())).map((x) => parseInt(x, 10) || 0);
    if (sig.length !== candles.length) return { error: `q returned ${sig.length} signals for ${candles.length} bars` };
    return { signals: sig };
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } }
}

const M = { 1: "long", 0: "flat", "-1": "short" };
const arrToFn = (signals) => (ctx) => M[signals[ctx.index]] ?? "flat";

// ── compile-once signalFns for the gauntlet (drop-ins for compileStrategy) ────
// The research gauntlet calls compileFor(code, lang) many times (per market /
// k-fold / noise). So we compile the C++ binary ONCE per code (cached), then run
// it per candle array (signals memoised per array) — exactly like Pyodide's
// compilePyStrategy. A missing toolchain throws with .toolMissing so the caller
// can skip cleanly.
const _cppBins = new Map(); // code → { exe } | Error

function ensureCppBinary(code) {
  const cached = _cppBins.get(code);
  if (cached) { if (cached instanceof Error) throw cached; return cached; }
  if (spawnSync(GPP, ["--version"], { timeout: 5000, windowsHide: true }).error) {
    const e = new Error("g++ not installed"); e.toolMissing = "g++"; _cppBins.set(code, e); throw e;
  }
  const dir = mkdtempSync(join(tmpdir(), "cppc-"));
  const src = join(dir, "strat.cpp");
  const exe = join(dir, process.platform === "win32" ? "strat.exe" : "strat.out");
  writeFileSync(src, cppSource(code));
  const comp = spawnSync(GPP, ["-O2", "-std=c++17", "-o", exe, src], { encoding: "utf8", timeout: 60000, windowsHide: true });
  if (comp.status !== 0) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    const e = new Error("compile: " + (comp.stderr || "unknown").split("\n").filter(Boolean).slice(0, 4).join(" | ").slice(0, 400));
    _cppBins.set(code, e); throw e;
  }
  const v = { exe }; _cppBins.set(code, v); return v;
}

function runCppBinary(exe, candles) {
  const run = spawnSync(exe, [], { input: candlesCsv(candles), encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 60000, windowsHide: true });
  if (run.status !== 0) throw new Error("runtime: " + (run.stderr || `exit ${run.status}`).slice(0, 300));
  const sig = run.stdout.trim().split("\n").filter((x) => x !== "").map((x) => parseInt(x, 10) || 0);
  if (sig.length !== candles.length) throw new Error(`C++ returned ${sig.length} signals for ${candles.length} bars`);
  return sig;
}

/** Compile C++ strategy → a candle-agnostic signalFn (compiled once, run per array). */
export function compileCppStrategy(code) {
  const { exe } = ensureCppBinary(code); // compiles once; throws (with .toolMissing) on failure
  const cache = new WeakMap();
  return (ctx) => {
    let sigs = cache.get(ctx.candles);
    if (!sigs) { sigs = runCppBinary(exe, ctx.candles); cache.set(ctx.candles, sigs); }
    return M[sigs[ctx.index]] ?? "flat";
  };
}

/** Compile q strategy → a candle-agnostic signalFn (interpreted; run per array). */
export function compileQStrategy(code) {
  if (spawnSync(QBIN, ["-q"], { timeout: 5000, input: "exit 0", windowsHide: true }).error) {
    const e = new Error("q not installed"); e.toolMissing = "q"; throw e;
  }
  const cache = new WeakMap();
  return (ctx) => {
    let sigs = cache.get(ctx.candles);
    if (!sigs) {
      const r = qSignals(code, ctx.candles);
      if (r.toolMissing) { const e = new Error("q not installed"); e.toolMissing = "q"; throw e; }
      if (r.error) throw new Error(r.error);
      sigs = r.signals; cache.set(ctx.candles, sigs);
    }
    return M[sigs[ctx.index]] ?? "flat";
  };
}

/**
 * Run a backtest natively. Returns the SAME shape as runBacktest plus { ok }, or
 * { ok:false, error|toolMissing } so the caller can report it cleanly.
 */
export async function nativeBacktest({ code, language = "js", candles, capital = 10000, feeBps = 10, positionPct = 100, leverage = 1, fundingRates = null }) {
  if (!Array.isArray(candles) || candles.length < 20) return { ok: false, error: "not enough candles" };
  const lang = String(language).toLowerCase();
  try {
    let signalFn;
    if (lang === "python" || lang === "py") {
      if (!pyReady()) await initPy();
      signalFn = compilePyStrategy(code); // Pyodide — supports signal-only + brackets
    } else if (lang === "cpp" || lang === "c++") {
      const r = cppSignals(code, candles);
      if (r.toolMissing) return { ok: false, toolMissing: r.toolMissing };
      if (r.error) return { ok: false, error: r.error };
      signalFn = arrToFn(r.signals);
    } else if (lang === "q" || lang === "kdb" || lang === "kdb+") {
      const r = qSignals(code, candles);
      if (r.toolMissing) return { ok: false, toolMissing: r.toolMissing };
      if (r.error) return { ok: false, error: r.error };
      signalFn = arrToFn(r.signals);
    } else {
      signalFn = compileStrategy(code); // js
    }
    const res = runBacktest({ candles, signalFn, initialCapital: capital, feeBps, positionPct, leverage, fundingRates });
    if (res.warnings?.length) return { ok: false, error: res.warnings[0] };
    return { ok: true, metrics: res.metrics, trades: res.trades, equity: res.equity, candleCount: candles.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}
