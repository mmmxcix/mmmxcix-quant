// pyRunner.js — run a Python strategy in the browser via Pyodide (CPython on
// WASM), and hand the result to the SAME backtest engine the JS path uses.
//
// Why this design: Python is the quant lingua franca (numpy/pandas), but we are
// a static SPA with no server. Pyodide runs real CPython client-side. Rather
// than call Python per bar (thousands of slow WASM round-trips), the Python
// side is VECTORISED: it receives the whole OHLCV as a pandas DataFrame and
// returns one signal per bar (1 long / 0 flat / -1 short). JS then runs the
// exact same fill/fee/buy-hold engine over those signals — identical accounting,
// identical honesty (fills at next open, no look-ahead), just the signal logic
// written in Python.
//
// Pyodide (~6 MB core + numpy/pandas wheels) loads lazily on first use, only
// when the user opts into Python mode. Cached across runs.

// Pin the version to the one verified working (node build 314.0.2). The CDN is
// allow-listed in public/_headers CSP (script-src + connect-src jsdelivr).
const PY_VERSION = "v314.0.2";
const PY_CDN = `https://cdn.jsdelivr.net/pyodide/${PY_VERSION}/full/`;

let _pyPromise = null;

/** Lazy-load Pyodide + numpy + pandas once. onProgress(msg) for UI feedback. */
export function loadPy(onProgress) {
  if (_pyPromise) return _pyPromise;
  _pyPromise = (async () => {
    if (!globalThis.loadPyodide) {
      onProgress?.("Downloading Python runtime (~6 MB, first time only)…");
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `${PY_CDN}pyodide.js`;
        s.onload = resolve;
        s.onerror = () => reject(new Error("Could not load Pyodide from the CDN."));
        document.head.appendChild(s);
      });
    }
    onProgress?.("Starting Python…");
    const py = await globalThis.loadPyodide({ indexURL: PY_CDN });
    onProgress?.("Loading numpy + pandas…");
    await py.loadPackage(["numpy", "pandas"]);
    return py;
  })().catch((e) => { _pyPromise = null; throw e; }); // let a failed load retry
  return _pyPromise;
}

/** True once Pyodide has finished loading in this session. */
export function pyReady() {
  return !!(globalThis.loadPyodide && _pyPromise);
}

/**
 * Run Python strategy `code` (which must define `signals(df)`) over `candles`.
 * @param {string} code    Python source defining `def signals(df): ...`
 * @param {Array}  candles [{ time, open, high, low, close, volume }]
 * @param {Function} [onProgress]
 * @returns {Promise<number[]>} one signal per bar: 1 long, 0 flat, -1 short
 */
export async function runPythonSignals(code, candles, onProgress) {
  const py = await loadPy(onProgress);
  onProgress?.("Running strategy…");

  // Hand the columns over as plain arrays (Pyodide converts to Python lists).
  py.globals.set("_o", candles.map((c) => c.open));
  py.globals.set("_h", candles.map((c) => c.high));
  py.globals.set("_l", candles.map((c) => c.low));
  py.globals.set("_c", candles.map((c) => c.close));
  py.globals.set("_v", candles.map((c) => c.volume ?? 0));

  // The user code defines signals(df); we build df, call it, and normalise the
  // result to a plain list of -1/0/1 ints the JS engine can read. The strategy
  // contract is documented in the editor template.
  // signals(df) may return a Series/array of -1/0/1 (signal-only) OR a DataFrame
  // with a 'signal' column plus optional 'stop'/'target' columns (intrabar bracket
  // orders — the same {signal,stop,target} the JS engine supports). Always yields
  // { signal:int[], stop, target } with stop/target float|None per bar.
  const wrapper =
    "import numpy as np\n" +
    "import pandas as pd\n" +
    "_df = pd.DataFrame({'open': list(_o), 'high': list(_h), 'low': list(_l), 'close': list(_c), 'volume': list(_v)})\n" +
    code + "\n" +
    "def _run():\n" +
    "    s = signals(_df)\n" +
    "    n = len(_df)\n" +
    "    if isinstance(s, pd.DataFrame):\n" +
    "        sig = np.asarray(s['signal']).astype(float) if 'signal' in s.columns else np.zeros(n)\n" +
    "        stop = np.asarray(s['stop']).astype(float) if 'stop' in s.columns else np.full(n, np.nan)\n" +
    "        target = np.asarray(s['target']).astype(float) if 'target' in s.columns else np.full(n, np.nan)\n" +
    "    else:\n" +
    "        sig = np.asarray(s).astype(float); stop = np.full(n, np.nan); target = np.full(n, np.nan)\n" +
    "    sig = np.clip(np.sign(np.nan_to_num(sig, nan=0.0)), -1, 1)\n" +
    "    if len(sig) != n:\n" +
    "        raise ValueError(f'signals returned {len(sig)} values for {n} bars')\n" +
    "    clean = lambda a: [None if (a[i] is None or np.isnan(a[i])) else float(a[i]) for i in range(n)]\n" +
    "    return {'signal': [int(x) for x in sig], 'stop': clean(stop), 'target': clean(target)}\n" +
    "_result = _run()\n";

  let result;
  try {
    py.runPython(wrapper);
    const proxy = py.globals.get("_result");
    result = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy?.();
  } catch (e) {
    // Pyodide surfaces the Python traceback in the message — keep the last line.
    const msg = String(e?.message || e).trim().split("\n").filter(Boolean).pop() || "Python error";
    throw new Error(msg.slice(0, 300));
  } finally {
    for (const k of ["_o", "_h", "_l", "_c", "_v", "_result"]) { try { py.globals.delete(k); } catch { /* noop */ } }
  }
  return result;
}

/** Map a Python signals result to the JS engine's per-bar signalFn contract.
 *  Accepts the legacy array shape OR the { signal, stop, target } bracket shape. */
export function signalsToFn(signals) {
  const M = { 1: "long", 0: "flat", "-1": "short" };
  if (Array.isArray(signals)) return (ctx) => M[signals[ctx.index]] ?? "flat"; // legacy signal-only
  const { signal, stop, target } = signals || {};
  return (ctx) => {
    const i = ctx.index;
    const sig = M[signal?.[i]] ?? "flat";
    const s = stop?.[i], t = target?.[i];
    return (s != null || t != null) ? { signal: sig, stop: s ?? undefined, target: t ?? undefined } : sig;
  };
}

/** The starter Python shown in the editor when the user switches to Python. */
export const PYTHON_TEMPLATE = `# Python strategy — define signals(df) returning one value per bar:
#   1 = long, 0 = flat, -1 = short.  No look-ahead: row i may only use rows <= i.
# df columns: open, high, low, close, volume  (pandas DataFrame). numpy + pandas available.
#
# For intrabar STOP/TARGET brackets, return a DataFrame instead of a Series:
#   return pd.DataFrame({'signal': sig, 'stop': stop_px, 'target': target_px})
# NaN in stop/target = no bracket that side. The engine fills the stop first if
# both sit inside one bar, exactly like the JS engine.
import numpy as np
import pandas as pd

def signals(df):
    close = df['close']
    fast = close.rolling(20).mean()
    slow = close.rolling(50).mean()
    sig = np.where(fast > slow, 1, 0)      # long while the fast MA is above the slow
    return pd.Series(sig, index=df.index).fillna(0)
`;
