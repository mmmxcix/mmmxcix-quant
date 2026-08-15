// extract.js — the model's half of the live path, as pure functions.
//
// Two strict-JSON rounds, the same shape /api/bias and /api/briefing already
// use, and for the same reason: the app's LLM path is a fallback chain across
// providers that each speak a different tool protocol, so a tool-calling loop
// would either bind this to one provider or carry four implementations. Two
// rounds of "reply with JSON and nothing else" run anywhere, including the local
// OmniRoute router the agents use.
//
//   round 1 — IS this a statement, and who made it? The regex in parse.js is
//   deliberately strict; it will miss a paraphrase ("the president signalled
//   that…") and every speaker not on the roster. The model widens recall.
//
//   round 2 — which of OUR themes does it belong to? A CLOSED list. The model
//   picks ids or returns none; it may not invent a theme, because a theme with
//   no measured history is exactly the narrative generator this project is
//   trying not to build.
//
// THE RULE THAT MATTERS MOST, and it is not a prompt. The lexicon in themes.js
// is what the historical study measured, so the lexicon is the AUTHORITY for any
// theme assignment that gets a number attached. The model's answer is recorded
// beside it and compared — never substituted. If the two disagree, the statement
// carries the lexicon's themes and a flag saying the model saw it differently.
// Swapping in a classifier that was never measured would silently invalidate
// every statistic on the page, which is the failure mode this whole project
// exists to avoid. Same discipline as the Argus setup scorecard: recorded, not
// applied.

import { THEMES } from "./themes.js";

const MAX_BATCH = 40;

export const ROUND1_SYSTEM = `You read raw market-wire headlines and find STATEMENTS BY PEOPLE.

A statement is a named, senior person saying or committing to something: a head of state, a finance minister, a central banker, a regulator, or the chief executive of a large listed company. "TRUMP: WE WILL DRILL" is a statement. "OIL RISES 3%" is not. "ANALYSTS EXPECT A CUT" is not — no named person said it. A report ABOUT what someone did ("the administration imposed tariffs") is not a statement; a report of what they SAID is.

Reply with STRICT JSON ONLY, no prose outside the JSON:
{"statements":[{"idx":0,"speaker":"Donald Trump","role":"US President","quote":"...","isStatement":true}]}

Rules:
- "idx" is the given index of the headline. Omit any headline that is not a statement rather than returning it with isStatement false.
- "speaker" is the person's name as an ordinary proper noun ("Donald Trump", not "TRUMP"). If a headline names only an institution ("ECB"), use that.
- "quote" is what they said, cleaned of the wire's own formatting, never invented or extended.
- Never add a fact that is not in the headline you were given.`;

export function round1Prompt(headlines) {
  const rows = headlines.slice(0, MAX_BATCH)
    .map((h, i) => `${i}: ${String(h.text || h.title || "").replace(/\s+/g, " ").slice(0, 300)}`);
  return `HEADLINES:\n${rows.join("\n")}`;
}

export const ROUND2_SYSTEM = `You map statements to investment themes from a CLOSED list.

You will be given the list of themes, each with an id and the mechanism it represents — who actually earns or loses money when the statement is true. Assign a statement to a theme ONLY when that mechanism applies. "We will build reactors" is nuclear power. "Iran must give up its enriched uranium" is NOT — that is non-proliferation, and the uranium miners are not the counterparty.

Most statements belong to NO theme. That is the normal answer and the correct one. Returning a weak match to be helpful is the failure mode here.

You may not invent a theme id. Only ids from the list are valid.

Reply with STRICT JSON ONLY:
{"assignments":[{"idx":0,"themes":["nuclear"],"confidence":"high"|"medium"|"low","because":"one short clause naming the mechanism"}]}`;

export function round2Prompt(statements) {
  const themes = THEMES.map((t) => `${t.id}: ${t.name} — ${t.why}`).join("\n");
  const rows = statements.slice(0, MAX_BATCH)
    .map((s, i) => `${i}: ${s.speaker} — ${String(s.quote).replace(/\s+/g, " ").slice(0, 300)}`);
  return `THEMES:\n${themes}\n\nSTATEMENTS:\n${rows.join("\n")}`;
}

/** Pull the JSON out of a reply that may be fenced or padded with prose. */
export function parseJson(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const trim = (s, n) => (typeof s === "string" ? s.slice(0, n).trim() : "");

/** Validate round 1 against the headlines it was given — indices must exist. */
export function parseRound1(text, headlines) {
  const j = parseJson(text);
  if (!j || !Array.isArray(j.statements)) return [];
  const out = [];
  for (const s of j.statements) {
    if (!Number.isInteger(s?.idx) || !headlines[s.idx]) continue;
    if (s.isStatement === false) continue;
    const quote = trim(s.quote, 400);
    const speaker = trim(s.speaker, 80);
    if (!quote || !speaker) continue;
    out.push({ idx: s.idx, speaker, role: trim(s.role, 80), quote, source: headlines[s.idx] });
  }
  return out;
}

const VALID_THEMES = new Set(THEMES.map((t) => t.id));

/**
 * Validate round 2. An invented theme id is DROPPED, not mapped to something
 * near it — a model that hallucinates a theme and gets quietly corrected to a
 * real one is worse than a model that gets ignored.
 */
export function parseRound2(text, statements) {
  const j = parseJson(text);
  if (!j || !Array.isArray(j.assignments)) return [];
  const out = [];
  for (const a of j.assignments) {
    if (!Number.isInteger(a?.idx) || !statements[a.idx]) continue;
    const themes = (Array.isArray(a.themes) ? a.themes : []).filter((t) => VALID_THEMES.has(t));
    const invented = (Array.isArray(a.themes) ? a.themes : []).filter((t) => !VALID_THEMES.has(t));
    out.push({
      idx: a.idx,
      themes,
      invented,
      confidence: ["high", "medium", "low"].includes(a.confidence) ? a.confidence : "low",
      because: trim(a.because, 200),
    });
  }
  return out;
}

/**
 * Put the two classifiers side by side.
 *
 * `themes` is what the study measured and is therefore what any statistic on the
 * page belongs to. `modelThemes` is what the model thought. `agreement` is one
 * of:
 *
 *   "agree"        — same set; the statistic and the narrative describe the
 *                    same thing
 *   "model-wider"  — the model added themes the lexicon does not have. The
 *                    extra ones carry NO history and must never be shown with a
 *                    median next to them.
 *   "model-narrow" — the model dropped one the lexicon matched. Usually the
 *                    lexicon over-matching, and worth reading: this is how the
 *                    next veto rule gets found.
 *   "disagree"     — no overlap at all.
 *
 * The disagreements are the point. They are the only cheap source of evidence
 * that the fixed lexicon is drifting away from what the words actually mean.
 */
export function reconcile({ lexiconThemes = [], modelThemes = [] }) {
  const lex = new Set(lexiconThemes), mod = new Set(modelThemes);
  const shared = [...lex].filter((t) => mod.has(t));
  const onlyModel = [...mod].filter((t) => !lex.has(t));
  const onlyLexicon = [...lex].filter((t) => !mod.has(t));
  // Order matters. "The model returned nothing at all" is model-narrow, not
  // disagreement — an empty set shares nothing with everything, so a plain
  // "no overlap → disagree" test mislabels the most common case there is.
  let agreement;
  if (!onlyModel.length && !onlyLexicon.length) agreement = "agree";        // includes both empty
  else if (!mod.size) agreement = "model-narrow";                            // model saw none of them
  else if (!lex.size) agreement = "model-wider";                             // lexicon saw none of them
  else if (onlyModel.length && !onlyLexicon.length) agreement = "model-wider";
  else if (onlyLexicon.length && !onlyModel.length) agreement = "model-narrow";
  else agreement = "disagree";                                               // both non-empty, genuinely apart
  return {
    themes: [...lex],            // the measured assignment — the only one with numbers
    modelThemes: [...mod],       // recorded, never applied
    agreement, onlyModel, onlyLexicon,
  };
}
