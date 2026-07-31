// exportLangs.js — REFERENCE exports of a strategy to C++ and kdb+/q.
//
// This tool's backtester executes only JavaScript and Python (Pyodide), so these
// are NOT runnable here. They are a clean, labelled scaffold in the target
// language — the strategy's tunable constants typed out, plus the EXACT validated
// source embedded as the spec — so you can port a strategy to a real C++ (incl.
// HFT) or kdb+/q environment without re-deriving the logic. Honest by design: it
// never claims to be a finished program, it hands you the structure + the spec.

import { codeParamSpace } from "./optimizer.js";

function commentBlock(src, prefix) {
  return String(src || "")
    .split("\n")
    .map((l) => `${prefix}${l}`.replace(/[ \t]+$/, ""))
    .join("\n");
}

const srcNote = (lang) => (lang === "python" ? "Python signals(df)" : "JavaScript strategy(ctx)");

/** C++ reference scaffold: typed constants + the validated source to port. */
export function toCpp({ name, source, sourceLang }) {
  const params = codeParamSpace(source);
  const consts = params.length
    ? params.map((p) => `    const double ${p.key} = ${p.default};`).join("\n")
    : "    // (no tunable constants detected in the source)";
  return `// ${name || "Strategy"} — C++ REFERENCE (not runnable in this tool; port to your engine).
//
// Generated from the validated ${srcNote(sourceLang)} source embedded below — that
// is the exact, backtested logic. Translate it into the loop, using ONLY bars up
// to index i (no look-ahead). Contract: one value per bar — +1 long, 0 flat, -1 short.
#include <vector>
#include <cmath>

struct Bar { double open, high, low, close, volume; };

std::vector<int> signals(const std::vector<Bar>& bars) {
${consts}
    const std::size_t n = bars.size();
    std::vector<int> sig(n, 0);

    // ---- PORT THE VALIDATED LOGIC BELOW (${sourceLang}) ----
${commentBlock(source, "    // ")}
    // ---- END ----

    return sig;
}
`;
}

/** kdb+/q reference scaffold: constants + the validated source to port. */
export function toQ({ name, source, sourceLang }) {
  const params = codeParamSpace(source);
  const consts = params.length
    ? params.map((p) => `  ${p.key}:${p.default};`).join("\n")
    : "  / (no tunable constants detected in the source)";
  return `/ ${name || "Strategy"} — kdb+/q REFERENCE (not runnable in this tool; port to your q environment).
/
/ Generated from the validated ${srcNote(sourceLang)} source embedded below — the
/ exact, backtested logic. t is a table with columns: open high low close volume
/ (one row per bar). Return a list of signals, one per row: 1 long, 0 flat, -1 short.
/ No look-ahead: row i may use only rows <= i.
signals:{[t]
${consts}
  / ---- PORT THE VALIDATED LOGIC BELOW (${sourceLang}) ----
${commentBlock(source, "  / ")}
  / ---- END ----
  count[t]#0 }
`;
}
