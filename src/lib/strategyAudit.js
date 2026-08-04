// strategyAudit.js — a CODE-VALIDITY audit for generated strategies. This is a
// different check from the statistical gauntlet (DSR / holdout / delayed-Sharpe):
// those grade the RESULTS, this reads the CODE for logic defects that make a
// backtest lie — the class of bug where a great-looking result is really an
// artifact (e.g. an "arbitrage" that only triggers on floating-point error, or a
// look-ahead peek at the next bar). Pure + dependency-free so it runs in the
// browser (Backtest page) and in the Node research-agent gauntlet alike.
//
// It is deliberately HIGH-PRECISION: every rule below fires on a concrete,
// unambiguous pattern so it doesn't cry wolf on healthy code. Findings are either
// "critical" (the result cannot be trusted → block/quarantine) or "warn" (a real
// weakness to fix, e.g. no risk exit).

const RULES = [
  {
    id: "arbitrage-illusion",
    severity: "critical",
    // Triangular-arbitrage / negative-cycle logic run on ONE asset's bar series is
    // mathematically degenerate: the log edge weights cancel to ~0, so the "profit"
    // is pure float rounding error (Gemini's Bellman-Ford finding).
    test: (code) => /\b(bellman[- ]?ford|arbitrage|negative[- ]?cycle|triangular|cross[- ]?rate)\b/i.test(code)
      && /(Math\.log|np\.log|\blog\s*\()/i.test(code),
    msg: "Arbitrage / negative-cycle logic on a single asset's bars is degenerate — the log edge-weights cancel to ~0, so it only triggers on floating-point error, not a real inefficiency. Use REAL data from 3 separate pairs, or drop the cycle solver and trade one clean mean-reversion signal.",
  },
  {
    id: "lookahead-index",
    severity: "critical",
    // Reading a FUTURE bar. JS: candles[i+1] / arr[i + 1]; Python: shift(-n) / iloc[i+1].
    test: (code, lang) => lang === "python"
      ? /\.shift\(\s*-\s*\d+\s*\)|\.iloc\[[^\]]*\+\s*1\s*\]|\[\s*i\s*\+\s*[1-9]/.test(code)
      : /\[\s*i\s*\+\s*[1-9]\d*\s*\]|candles\s*\[[^\]]*\+\s*[1-9]/.test(code),
    msg: "Reads a FUTURE bar (look-ahead). Decisions must use only data available up to the current close — a backtest that peeks at the next bar cannot be traded.",
  },
  {
    id: "future-close-exec",
    severity: "warn",
    // Common subtle look-ahead: deciding AND filling on the same bar's close.
    test: (code) => /\bfuture\b|next[_ ]?bar|tomorrow|forward[- ]?fill.*signal/i.test(code),
    msg: "Mentions future/next-bar data — make sure the signal at bar i is executed at bar i+1's open, never on the same close it was computed from.",
  },
  {
    id: "no-risk-exit",
    severity: "warn",
    // No stop / target / trailing / ATR-based exit anywhere: the position only ever
    // flips on an opposite signal, so a single bad trade can run unbounded.
    test: (code) => !/(stop|target|trailing|trail|\bsl\b|\btp\b|\.atr|atr\(|drawdown|risk)/i.test(code),
    msg: "No stop-loss, target or trailing exit — the position rides until an opposite signal, so one bad trade can run unbounded. Add ATR- or structure-based risk management.",
  },
  {
    id: "float-equality",
    severity: "warn",
    // Exact equality on computed floats almost never holds and hides logic errors.
    test: (code) => /[)\]\w]\s*===?\s*0(?:\.0+)?\b(?!\s*[)\]])/.test(code) && /(Math\.|np\.|\/|\*)/.test(code),
    msg: "Exact float equality/`=== 0` on a computed value — floating-point math rarely lands exactly, so compare against a small epsilon instead.",
  },
  {
    id: "constant-signal",
    severity: "critical",
    // The function's only return is a single constant side → it's not a strategy.
    test: (code) => {
      const rets = [...code.matchAll(/return\s+["'`](long|short|flat|buy|sell|hold)["'`]/gi)].map((m) => m[1].toLowerCase());
      if (rets.length < 1) return false;
      const nonFlat = rets.filter((r) => r !== "flat" && r !== "hold");
      return nonFlat.length > 0 && new Set(rets).size === 1; // every return is the SAME single side
    },
    msg: "The strategy returns a single constant side on every path — that's a static position, not a signal. The decision must depend on the price data.",
  },
];

/**
 * Audit a strategy's source for logic defects that would make its backtest lie.
 * @param {string} code   the strategy source
 * @param {string} lang   "js" | "python"
 * @returns {{ findings: {id,severity,msg}[], blocked: boolean, critical: number, warnings: number }}
 */
export function auditStrategy(code, lang = "js") {
  const src = String(code || "");
  if (!src.trim()) return { findings: [], blocked: false, critical: 0, warnings: 0 };
  const findings = [];
  for (const r of RULES) {
    try { if (r.test(src, lang)) findings.push({ id: r.id, severity: r.severity, msg: r.msg }); }
    catch { /* a rule must never throw the audit */ }
  }
  const critical = findings.filter((f) => f.severity === "critical").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  return { findings, blocked: critical > 0, critical, warnings };
}
