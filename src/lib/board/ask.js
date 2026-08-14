// ask.js — the chat over the board, as pure functions.
//
// WHY NOT TOOL-CALLING. The obvious build is the provider's tool API and an
// agent loop. This app's LLM path is a FALLBACK CHAIN across four providers
// (Anthropic → Mistral → Groq → Gemini, see functions/api/generate.js) whose
// free tiers are what keep a public endpoint free, and each speaks a different
// tool protocol — so a tool loop would either bind the chat to one provider or
// carry four implementations. Worse, it could not run on the user's LOCAL
// OmniRoute / CLI shim, which is the whole reason the Backtest builder can use a
// strong model at no cost.
//
// So the same shape /api/bias and /api/briefing already use: STRICT JSON, no
// tool API. Two turns, both provider-agnostic:
//
//   1. PLAN   — the model sees the catalog (ids, one-line summaries, arguments)
//               and returns which reads answer the question.
//   2. ANSWER — the reads are executed by the board, and the model answers
//               ONLY from the digests it gets back.
//
// One optional third turn (a follow-up read set) exists for questions that
// cannot be planned in one go. The ceiling is two read rounds; an agent that can
// loop forever on a public endpoint is a bill, not a feature.
//
// Everything here is pure so test/ask.test.mjs can pin the parsing and the
// refusals without a provider.

/** Hard ceilings — the same numbers the endpoint enforces, kept next to the prompts. */
export const MAX_READS_PER_ROUND = 6;
export const MAX_ROUNDS = 2;
export const MAX_QUESTION_CHARS = 500;

/** The catalog as prompt text: id, what it answers, and its arguments. */
export function catalogPrompt(resources) {
  return resources
    .map((r) => {
      const args = (r.args || [])
        .map((a) => {
          const type = a.values ? a.values.join("|") : a.type;
          return `${a.name}${a.required ? "*" : ""}:${type}${a.default != null ? `=${a.default}` : ""}`;
        })
        .join(" ");
      return `- ${r.id}(${args}) — ${r.summary}`;
    })
    .join("\n");
}

export const PLANNER_SYSTEM = `You plan data reads for a quant tool. You do NOT answer the question — you only decide which of the available resources to read.

Reply with STRICT JSON ONLY, no prose and no markdown fences:
{"reads":[{"resource":"<id>","args":{...}}],"note":"<why, one short sentence>"}

Rules:
- Use ONLY resource ids from the list. Never invent one, and never invent an argument name — an unknown argument is REFUSED, not ignored, and the read is wasted.
- At most ${MAX_READS_PER_ROUND} reads. Prefer the smallest set that can actually answer.
- Prefer an aggregate over a dump: argus.performance with a grouping answers "which setups lose" far better than argus.trades.
- If the question cannot be answered by any resource, return {"reads":[],"note":"..."} explaining what is missing. That is a correct answer, not a failure.
- Time windows are durations like 24h, 7d, 4w, or "all".`;

export function plannerUser(question, resources) {
  return `AVAILABLE RESOURCES\n${catalogPrompt(resources)}\n\nQUESTION\n${String(question).slice(0, MAX_QUESTION_CHARS)}`;
}

export const ANSWER_SYSTEM = `You answer questions about a personal quant tool's own agents and market data. This is an educational tool. NOT investment advice.

You are given DIGESTS produced by the tool itself. Rules, in order of importance:
1. Every number you state must appear in the digests. Never estimate, never round a figure you were not given, never fill a gap with something plausible.
2. If a digest says a source is STALE or absent, say so in the answer. An old number presented as current is worse than no answer.
3. If the digests do not contain the answer, say exactly that and name what is missing. Do not reason your way to a substitute.
4. Sample size travels with every average: "-0.29R over 98 trades", never "-0.29R".
5. Be brief and concrete. Two to six sentences unless a table genuinely helps. No preamble, no "based on the data provided".
6. Never recommend a trade, a position size, or an entry. Describing what the agents did is fine; telling the reader what to do is not.`;

/** The arguments belong in the heading: a plan often reads ONE resource twice
 *  with different slices, and two identical headings make the two indistinguishable. */
const headingOf = (r) => {
  const args = r.args && Object.keys(r.args).length
    ? `(${Object.entries(r.args).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${v}`).join(", ")})`
    : "";
  return `${r.resource}${args}`;
};

export function answerUser(question, reads) {
  const body = reads
    .map((r) => {
      if (!r.ok) return `### ${headingOf(r)}\nFAILED: ${r.error}${r.detail ? ` (${r.detail})` : ""}`;
      const age = r.asOf ? new Date(r.asOf).toISOString() : "no timestamp";
      return `### ${headingOf(r)}${r.stale ? "  [STALE]" : ""}\nas of ${age}\n${r.digest}`;
    })
    .join("\n\n");
  return `QUESTION\n${String(question).slice(0, MAX_QUESTION_CHARS)}\n\nDIGESTS\n${body || "(nothing was read)"}`;
}

/** Sanity ceiling on model output — a plan is a few dozen bytes, not a document. */
const MAX_PLAN_CHARS = 4000;

/**
 * Parse a planner reply into reads. Tolerant of a fenced block or stray prose
 * around the JSON (every provider in the chain does this occasionally), strict
 * about the shape once found — an unparseable plan must fall through to the
 * next provider rather than silently becoming an empty read set.
 * @returns {{reads: Array<{resource:string,args:object}>, note: string}|null}
 */
export function parsePlan(text) {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_PLAN_CHARS) return null;
  let raw = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (raw[0] !== "{") {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    raw = raw.slice(start, end + 1);
  }
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.reads)) return null;

  const reads = [];
  for (const r of obj.reads.slice(0, MAX_READS_PER_ROUND)) {
    const resource = typeof r?.resource === "string" ? r.resource.trim() : "";
    if (!resource) continue;
    const args = r.args && typeof r.args === "object" && !Array.isArray(r.args) ? r.args : {};
    reads.push({ resource, args });
  }
  return { reads, note: typeof obj.note === "string" ? obj.note.slice(0, 300) : "" };
}

/**
 * Drop reads the catalog does not have BEFORE spending a round trip on them,
 * and say which were dropped. The endpoint would refuse them anyway; catching it
 * here means the answer can tell the reader the model asked for something that
 * does not exist, instead of showing a bare "unknown_resource".
 */
export function screenPlan(reads, knownIds) {
  const known = new Set(knownIds);
  const keep = [], dropped = [];
  for (const r of reads) (known.has(r.resource) ? keep : dropped).push(r.resource);
  return { reads: reads.filter((r) => known.has(r.resource)), kept: keep, dropped };
}
