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
