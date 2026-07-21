// pyRunnerNode.mjs — run a Python strategy in Node via the pyodide npm package
// (CPython on WASM), and hand the result to the SAME JS backtest engine the rest
// of Cortex uses. This is the Node twin of src/lib/pyRunner.js (which loads
// Pyodide from a CDN in the browser); the strategy contract is identical:
//
//   def signals(df) -> one value per row: 1 long / 0 flat / -1 short
//
// so a Python strategy validated here trades bit-for-bit the same as it would in
// the browser editor — identical fills (next open), fees, and buy-hold accounting.
//
// WHY THIS SHAPE. runBacktest calls signalFn(ctx) once per bar, synchronously, in
// a tight loop. Pyodide's py.runPython() is synchronous ONCE the runtime is
// loaded — only loading is async. So we load Pyodide + numpy + pandas ONCE at
// agent startup (await initPy), then compilePyStrategy() returns a plain sync
// signalFn that is a drop-in for backtest.js's compileStrategy(): it lazily
// vectorises the Python over whatever candle array runBacktest feeds it (memoised
// per array), and indexes the resulting signal array by ctx.index. That means it
// works unchanged inside k-fold (fold slices), the noise test (perturbed copies)
// and the 1-bar-delay probe — each just passes a different candle array, and each
// gets its signals recomputed in Python. Correct by construction, no JS mirror of
// the strategy logic anywhere.

import { loadPyodide } from "pyodide";

let _py = null;
let _loading = null;

/**
 * Load Pyodide + numpy + pandas exactly once. Await this before the gauntlet.
 * @param {(msg:string)=>void} [onProgress]
 * @returns {Promise<object>} the pyodide instance
 */
export async function initPy(onProgress) {
  if (_py) return _py;
  if (_loading) return _loading;
  _loading = (async () => {
    onProgress?.("loading Python runtime (numpy + pandas)…");
    const py = await loadPyodide();
    await py.loadPackage(["numpy", "pandas"]);
    // A tiny warm-up compile so the first real strategy doesn't pay import cost.
    py.runPython("import numpy as np\nimport pandas as pd\n");
    _py = py;
    return py;
  })().catch((e) => { _loading = null; throw e; });
  return _loading;
}

/** True once initPy() has resolved in this process. */
export function pyReady() { return !!_py; }

// The wrapper is assembled once per call around the user code. It mirrors the
// browser runner's normalisation exactly: sign() so any positive→long,
// negative→short; NaN→0 (warm-up); and a hard length check so a mis-shaped
// Series is a loud failure, never a silent misalignment.
function buildWrapper(code) {
  return (
    "import numpy as np\n" +
    "import pandas as pd\n" +
    "_df = pd.DataFrame({'open': list(_o), 'high': list(_h), 'low': list(_l), 'close': list(_c), 'volume': list(_v)})\n" +
    code + "\n" +
    "def _run():\n" +
    "    s = signals(_df)\n" +
    "    arr = np.asarray(s).astype(float)\n" +
    "    arr = np.nan_to_num(arr, nan=0.0)\n" +
    "    arr = np.clip(np.sign(arr), -1, 1)\n" +
    "    if len(arr) != len(_df):\n" +
    "        raise ValueError(f'signals returned {len(arr)} values for {len(_df)} bars')\n" +
    "    return [int(x) for x in arr]\n" +
    "_result = _run()\n"
  );
}

/**
 * Run Python `code` (defining signals(df)) over `candles` SYNCHRONOUSLY.
 * Requires initPy() to have already resolved. Throws with the Python traceback's
 * last line on any error (compile, runtime, or wrong length).
 * @param {string} code
 * @param {Array}  candles [{time,open,high,low,close,volume}]
 * @returns {number[]} one signal per bar: 1 / 0 / -1
 */
export function pyStrategySignals(code, candles) {
  if (!_py) throw new Error("Pyodide not initialised — await initPy() first.");
  const py = _py;
  py.globals.set("_o", candles.map((c) => c.open));
  py.globals.set("_h", candles.map((c) => c.high));
  py.globals.set("_l", candles.map((c) => c.low));
  py.globals.set("_c", candles.map((c) => c.close));
  py.globals.set("_v", candles.map((c) => c.volume ?? 0));
  try {
    py.runPython(buildWrapper(code));
    const proxy = py.globals.get("_result");
    const out = Array.from(proxy.toJs());
    proxy.destroy?.();
    return out;
  } catch (e) {
    const msg = String(e?.message || e).trim().split("\n").filter(Boolean).pop() || "Python error";
    throw new Error(msg.slice(0, 300));
  } finally {
    for (const k of ["_o", "_h", "_l", "_c", "_v", "_result"]) { try { py.globals.delete(k); } catch { /* noop */ } }
  }
}

const SIGMAP = { 1: "long", 0: "flat", "-1": "short" };

/**
 * Compile Python strategy `code` into a candle-agnostic signalFn — a DROP-IN for
 * backtest.js's compileStrategy(). The returned fn vectorises the Python over the
 * candle array it is called with (memoised per array via a WeakMap), so it slots
 * unchanged into runBacktest, k-fold, the noise test and the delay probe.
 *
 * Signals are computed on FIRST touch of a given candle array (bar 0 of a run)
 * and reused for every later bar of that run — one Python call per backtest, not
 * one per bar. A compile/runtime error surfaces on that first call, which the
 * gauntlet already catches exactly like a JS compile error.
 *
 * @param {string} code Python source defining signals(df)
 * @returns {(ctx:object)=>string} signalFn
 */
export function compilePyStrategy(code) {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("Strategy code is empty — define signals(df).");
  }
  if (!/\bdef\s+signals\s*\(/.test(code)) {
    throw new Error('Python strategy must define a function named "signals", e.g. `def signals(df): ...`.');
  }
  const cache = new WeakMap(); // candle array → signal array (one Python run per array)
  return (ctx) => {
    let sigs = cache.get(ctx.candles);
    if (!sigs) { sigs = pyStrategySignals(code, ctx.candles); cache.set(ctx.candles, sigs); }
    return SIGMAP[sigs[ctx.index]] ?? "flat";
  };
}

// A small synthetic series (trending + noisy) to prove a strategy actually
// compiles AND runs in Python before it costs a gauntlet trial — the Python twin
// of "does this JS compile". Returns { ok, trades? , error? }.
function syntheticCandles(n = 240) {
  const out = [];
  let p = 100, t = 1_600_000_000;
  for (let i = 0; i < n; i++) {
    p *= 1 + Math.sin(i / 11) * 0.01 + (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.012;
    const o = p * (1 - 0.002), c = p, hi = Math.max(o, c) * 1.003, lo = Math.min(o, c) * 0.997;
    out.push({ time: t + i * 3600, open: o, high: hi, low: lo, close: c, volume: 1000 });
  }
  return out;
}

/**
 * Compile-and-run check for Python code: does it define signals(df) and run
 * cleanly on a synthetic series? Throws (with the Python error) if not — same
 * contract as calling compileStrategy() in a try/catch for JS.
 * @param {string} code
 */
export function pyCompileCheck(code) {
  const fn = compilePyStrategy(code);
  // Force one evaluation so a runtime error surfaces here, not mid-gauntlet.
  fn({ candles: syntheticCandles(), index: 0 });
  return true;
}
