// codegen.mjs — post-processing shared between the site's /api/generate and
// the local research agent. Lives in one place so the agent's OmniRoute path
// and the server's provider chain can never drift apart.

/** First fenced code block, or the whole text. */
export function extractCode(text) {
  const fenced = text.match(/```[a-z]*\s*\n?([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

// Rescue a common model quirk deterministically: sometimes the model emits only
// the BODY of the strategy — bare statements that use `ctx` and `return` — with
// no `function strategy(ctx){…}` wrapper, which then fails to compile. Rather
// than spend an LLM self-repair call on such a mechanical omission, wrap it.
// Strategies that already define strategy() (including ones with persistent
// top-level state) are left untouched.
export function ensureStrategyFn(code) {
  const defined = /\bfunction\s+strategy\s*\(/.test(code) || /\b(?:const|let|var)\s+strategy\s*=/.test(code);
  if (defined) return code;
  if (/\bctx\b/.test(code) && /\breturn\b/.test(code)) {
    return `function strategy(ctx) {\n${code}\n}`;
  }
  return code; // not recognisable — let compile/repair handle it
}

// Pull the committee verdict JSON out of a model reply. Returns a normalised
// object (never throws) so a malformed reply degrades to a usable shell rather
// than crashing the pipeline.
export function parseVerdict(text) {
  let obj = null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { obj = null; }
  }
  const clampConf = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
  };
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  return {
    bull: str(obj?.bull, 500),
    bear: str(obj?.bear, 500),
    confidence: clampConf(obj?.confidence),
    regime: str(obj?.regime, 60),
    invalidations: Array.isArray(obj?.invalidations)
      ? obj.invalidations.filter((x) => typeof x === "string").slice(0, 4).map((x) => x.slice(0, 200))
      : [],
    // Keep the raw text when parsing failed entirely, so nothing is silently lost.
    raw: obj ? undefined : text.slice(0, 600),
  };
}

// Parse the LLM code-review reply into structured bugs. A "critical" bug means the
// backtest results can't be trusted (look-ahead, degenerate signal, wrong math); a
// "warning" is a real weakness to fix. Defensive: models wrap JSON in prose/fences.
export function parseCodeReview(text) {
  let t = String(text || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) t = fenced[1].trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  let o = null;
  if (a !== -1 && b > a) { try { o = JSON.parse(t.slice(a, b + 1)); } catch { o = null; } }
  if (!o) return { verdict: "unknown", bugs: [], confidence: 0, summary: "", raw: text.slice(0, 500) };
  const bugs = (Array.isArray(o.bugs) ? o.bugs : [])
    .map((x) => ({
      severity: x?.severity === "critical" ? "critical" : "warning",
      issue: String(x?.issue || "").slice(0, 300),
      fix: String(x?.fix || "").slice(0, 300),
    }))
    .filter((x) => x.issue)
    .slice(0, 8);
  const hasCrit = bugs.some((x) => x.severity === "critical");
  const verdict = hasCrit || o.verdict === "buggy" ? "buggy" : bugs.length ? "buggy" : "clean";
  const conf = Math.round(Number(o.confidence));
  return {
    verdict, bugs,
    confidence: Number.isFinite(conf) ? Math.min(100, Math.max(0, conf)) : 0,
    summary: String(o.summary || "").slice(0, 300),
  };
}
