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
    msg: "Mentions future/next-bar data — a decision at bar i may only use information available up to bar i's close. (The ENGINE decides where that decision fills; the strategy must never read a bar that hasn't happened.)",
  },
  {
    id: "no-risk-exit",
    severity: "warn",
    // No stop / target / trailing exit anywhere: the position only ever flips
    // on an opposite signal, so a single bad trade can run unbounded. NOTE:
    // merely MENTIONING atr/risk no longer suppresses this — three library
    // strategies computed ATR for their entries yet had no stop at all.
    test: (code) => !/(stop|target|trailing|trail|\bsl\b|\btp\b|drawdown)/i.test(code),
    msg: "No stop-loss, target or trailing exit — the position rides until an opposite signal, so one bad trade can run unbounded. Add ATR- or structure-based risk management.",
  },
  {
    id: "float-equality",
    severity: "warn",
    // Exact equality on a COMPUTED FLOAT rarely holds and hides logic errors. Only
    // flag high-confidence cases so legit integer idioms — i===0, .length===0,
    // count===0, signal===0, a % n === 0 — are NOT falsely warned (the old rule
    // fired on any `===0` whenever the file contained a `*` or `/` anywhere, which
    // tripped constantly on normal code):
    //  (a) a Math.*(…) call compared with ==/=== to a number, or
    //  (b) an explicit `a * b` / `a / b` expression compared with ==/=== to a number, or
    //  (c) any ==/=== against a DECIMAL literal (=== 1.5) — always a float compare.
    test: (code) => {
      // Math.fn(…) === num — allow ONE level of nested parens (e.g. an indicator
      // call inside: Math.abs(close - sma(50)) === 0).
      const mathCall = /Math\.\w+\s*\((?:[^()]|\([^()]*\))*\)\s*===?\s*-?\d+(?:\.\d+)?/;
      const arithExpr = /[\w.\])]\s*[*/]\s*[\w.([\d]+\s*===?\s*-?\d+(?:\.\d+)?/;
      const decimalRhs = /===?\s*-?\d+\.\d+\b/;
      return mathCall.test(code) || arithExpr.test(code) || decimalRhs.test(code);
    },
    msg: "Exact float equality on a computed value — floating-point math rarely lands exactly, so compare against a small epsilon (e.g. Math.abs(x) < 1e-9) instead.",
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
  {
    id: "self-inclusive-extreme-exit",
    severity: "critical",
    // Pandas: an exit level built as close.rolling(n).min() INCLUDES the
    // current close, so `close < exit_level` is mathematically impossible —
    // the exit is dead code and the tested behavior is not the described
    // strategy (found in the wild: "EMA trend (long)" / "Bitcoin-Google").
    // Correct code shifts the window (`.shift(1)`), which suppresses this.
    // Mirror for a max-based breakout exit with a strict `>`.
    test: (code) => {
      if (/df\[['"]close['"]\]\s*<\s*df\[['"]close['"]\]\.rolling\([^)]*\)\.min\(\)(?!\s*\.shift)/.test(code)) return true;
      if (/df\[['"]close['"]\]\s*>\s*df\[['"]close['"]\]\.rolling\([^)]*\)\.max\(\)(?!\s*\.shift)/.test(code)) return true;
      // Named form: X = df['close'].rolling(n).min()  …  df['close'] < X
      for (const m of code.matchAll(/(?:df\[['"](\w+)['"]\]|(\w+))\s*=\s*df\[['"]close['"]\]\.rolling\([^)]*\)\.(min|max)\(\)\s*$/gm)) {
        const name = m[1] || m[2];
        const ref = m[1] ? `df\\[['"]${name}['"]\\]` : `\\b${name}\\b`;
        const cmp = m[3] === "min" ? "<" : ">";
        if (new RegExp(`df\\[['"]close['"]\\]\\s*${cmp}\\s*${ref}(?!\\s*\\.shift)`).test(code)) return true;
      }
      return false;
    },
    msg: "Impossible exit: the exit level is close.rolling(n).min()/max() INCLUDING the current bar, so `close < min` (or `close > max`) can never be true — the exit is dead code and positions only ever leave when the entry condition lapses. Shift the window (`.rolling(n).min().shift(1)`) or build the level from low/high.",
  },
  {
    id: "prev-bar-anchored-bracket",
    severity: "warn",
    // A "stop loss / target" computed as the ONE-BAR return (close[i] vs
    // close[i-1]) is not a bracket from the entry price — the stated risk
    // management doesn't exist; it merely reacts to single-bar moves.
    test: (code) => /\.iloc\[i\]\s*-\s*df\[['"]close['"]\]\.iloc\[i\s*-\s*1\]\s*\)\s*\/\s*df\[['"]close['"]\]\.iloc\[i\s*-\s*1\]\s*[<>]=?\s*-?\s*\w*(stop|target|tp|sl)\w*/i.test(code),
    msg: "The stop/target is measured on the PREVIOUS bar's one-bar move, not from the entry price — a 2% stop that only sees single-bar drops lets a slow 10% bleed through. Anchor the bracket to the recorded entry price.",
  },
  {
    id: "hardcoded-price-level",
    severity: "warn",
    // A literal price compared against close/price (e.g. `close > 4270`) welds
    // the strategy to ONE instrument's current price régime: run it anywhere
    // else (or after a big move) and it either never trades or fires
    // constantly. 3+ digits so indicator thresholds (rsi > 70) don't trip it.
    test: (code) => /\b(close|price|open|high|low)\b\s*[<>]=?\s*\d{3,}(?:\.\d+)?\b/.test(code)
      || /\d{3,}(?:\.\d+)?\s*[<>]=?\s*\b(close|price|open|high|low)\b/.test(code),
    msg: "Hardcoded price level compared against price (e.g. `close > 4270`) — this welds the strategy to one instrument at one point in time; on any other symbol or after a trend it stops working or fires constantly. Use relative levels (Donchian bands, swing highs/lows, % offsets) instead.",
  },
  {
    id: "inverted-long-bracket",
    severity: "critical",
    // Mirror of inverted-short-bracket: a LONG whose stop is ONLY ever computed
    // ABOVE entry (close + …) — the sell-stop sits in profit, so (before the
    // engine's fill clamp) every trade exited at a guaranteed gain. A correct
    // dual-side strategy computes a `close − …` stop for its long, which
    // suppresses this.
    test: (code) => {
      const longBracket = /\bsignal\s*:\s*["']long["'][^}]*\b(stop|target)\b/.test(code) || /["']long["']\s*,\s*(stop|target)/.test(code);
      if (!longBracket) return false;
      const stopAbove = /\bstop\b\s*[:=][^;\n]*\b(close|price|entry|hl2|mid)\b[^;\n]*\+/.test(code);
      const stopBelow = /\bstop\b\s*[:=][^;\n]*\b(close|price|entry|hl2|mid)\b[^;\n]*-/.test(code);
      return stopAbove && !stopBelow;
    },
    msg: "Side-inverted brackets: a LONG uses a stop computed ABOVE entry (close + …) — a sell-stop above the market triggers immediately and (uncorrected) books a guaranteed profit every trade. A long's stop must be BELOW entry, its target ABOVE. Compute stop/target per side.",
  },
  {
    id: "inverted-short-bracket",
    severity: "critical",
    // A SHORT that reuses long-style brackets: stop computed BELOW entry
    // (close − …) and target ABOVE — so the stop sits in profit and the target in a
    // loss. High precision: only fires when the code returns a short bracket AND the
    // stop is ONLY ever computed below the price, never above. A correct dual-side
    // strategy computes a `close + …` stop for its short, which suppresses this.
    test: (code) => {
      const shortBracket = /\bsignal\s*:\s*["']short["'][^}]*\b(stop|target)\b/.test(code) || /["']short["']\s*,\s*(stop|target)/.test(code);
      if (!shortBracket) return false;
      const stopBelow = /\bstop\b\s*[:=][^;\n]*\b(close|price|entry|hl2|mid)\b[^;\n]*-/.test(code);
      const stopAbove = /\bstop\b\s*[:=][^;\n]*\b(close|price|entry|hl2|mid)\b[^;\n]*\+/.test(code);
      return stopBelow && !stopAbove;
    },
    msg: "Side-inverted brackets: a SHORT reuses a stop computed BELOW entry (close − …) and a target ABOVE — that puts the stop in profit and the target in a loss. A short's stop must be ABOVE entry, its target BELOW. Compute stop/target per side.",
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
