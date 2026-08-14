// /api/ask — the chat on top of the board.
//
// Two turns, both strict-JSON and provider-agnostic (see src/lib/board/ask.js
// for why this is not a tool-calling loop): the model PLANS which resources to
// read, the board EXECUTES those reads with exactly the machinery /api/board
// uses, and the model ANSWERS from the digests alone.
//
// Public and rate-limited, on the free provider tiers only — same posture as
// /api/bias and /api/briefing. Admin resources still require an admin session:
// the visibility passed into every read is the CALLER's, so a public chat can
// neither read nor mention the private half of the catalog. It cannot see it in
// the plan either, because the planner is only shown what the caller may read.
//
// Three shapes, so a LOCAL model (OmniRoute or the CLI shim, as the Backtest
// builder already does) can drive the same flow without any provider key here:
//   POST { question }                → { answer, plan, reads, model }
//   POST { question, promptOnly:true } → { system, user, resources }   (no LLM)
//   POST { question, plan }          → { reads, answer: {system, user} } (no LLM)

import { isAdminRequest } from "../_lib/auth.mjs";
import { rateLimit, clientIp } from "../_lib/ratelimit.mjs";
import { makeLoader, runRead } from "../_lib/board.mjs";
import { listResources } from "../../src/lib/board/catalog.js";
import {
  ANSWER_SYSTEM, MAX_QUESTION_CHARS, MAX_READS_PER_ROUND, PLANNER_SYSTEM,
  answerUser, parsePlan, plannerUser, screenPlan,
} from "../../src/lib/board/ask.js";

// The chat costs two provider calls per question, so it is rate-limited harder
// than the board's plain reads.
const RATE = { limit: 10, windowMs: 60_000 };
const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * One LLM turn across the free chain, validated INSIDE the chain: a reply that
 * cannot be parsed is as useless as no reply, so it must fall through to the
 * next provider rather than ending the request. (bias.js learned this the hard
 * way — see its comment.)
 */
async function callLLM(env, { system, user, maxTokens = 900, validate }) {
  const chain = [];
  const oai = (base, key, model) => async () => {
    // gpt-oss is a reasoning model: its chain-of-thought is billed against
    // max_tokens and returned separately, so a small budget yields EMPTY content.
    const reasoner = /gpt-oss/i.test(model);
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: reasoner ? maxTokens + 1800 : maxTokens,
        temperature: 0.2,
        ...(reasoner ? { reasoning_effort: "low" } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content || "";
    return text ? { text, model } : null;
  };
  if (env.GROQ_API_KEY) for (const m of GROQ_MODELS) chain.push(oai("https://api.groq.com/openai/v1", env.GROQ_API_KEY, m));
  if (env.GEMINI_API_KEY) {
    chain.push(async () => {
      for (const model of GEMINI_MODELS) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
          }),
        });
        if (r.ok) {
          const d = await r.json();
          const text = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n");
          if (text) return { text, model };
        } else if (r.status !== 429 && r.status !== 404) break;
      }
      return null;
    });
  }

  for (const step of chain) {
    try {
      const out = await step();
      if (!out?.text) continue;
      const parsed = validate ? validate(out.text) : out.text;
      if (parsed) return { ...out, parsed };
    } catch { /* next provider */ }
  }
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const gate = rateLimit(`ask:${clientIp(request)}`, RATE.limit, RATE.windowMs);
  if (!gate.ok) {
    return new Response(JSON.stringify({ error: "rate_limited", retryAfter: gate.retryAfter }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(gate.retryAfter) },
    });
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, MAX_QUESTION_CHARS) : "";
  if (!question) return json({ error: "no_question" }, 400);

  const visibility = (await isAdminRequest(env, request).catch(() => false)) ? "admin" : "public";
  // The planner only ever sees what this caller may read, so a public chat
  // cannot even learn that the private resources exist.
  const resources = listResources({ visibility });
  const knownIds = resources.map((r) => r.id);

  // Shape 2: hand the prompt back for a local model to run.
  if (body.promptOnly === true) {
    return json({ ok: true, visibility, system: PLANNER_SYSTEM, user: plannerUser(question, resources), resources });
  }

  const execute = async (plan) => {
    const screened = screenPlan(plan.reads, knownIds);
    const load = makeLoader({ env, origin: new URL(request.url).origin, request });
    const reads = await Promise.all(
      screened.reads.slice(0, MAX_READS_PER_ROUND)
        .map((r) => runRead(load, r, { visibility, now: Date.now() })),
    );
    return { reads, dropped: screened.dropped };
  };

  // Shape 3: a local model already produced the plan — execute it and hand back
  // the answer prompt. No provider key is touched on this path.
  if (body.plan) {
    const plan = parsePlan(typeof body.plan === "string" ? body.plan : JSON.stringify(body.plan));
    if (!plan) return json({ error: "bad_plan" }, 400);
    const { reads, dropped } = await execute(plan);
    return json({
      ok: true, visibility, plan, dropped, reads,
      answer: { system: ANSWER_SYSTEM, user: answerUser(question, reads) },
    });
  }

  // Shape 1: the whole flow, server-side.
  const planned = await callLLM(env, {
    system: PLANNER_SYSTEM,
    user: plannerUser(question, resources),
    maxTokens: 500,
    validate: parsePlan,
  });
  if (!planned) {
    return json({
      ok: false,
      error: "no_llm",
      hint: "No provider answered. The board itself still works — /api/board needs no model.",
    }, 503);
  }

  const plan = planned.parsed;
  if (!plan.reads.length) {
    // A planner that finds nothing is a real answer, and it must not be dressed
    // up as one from the model — there is no data behind it.
    return json({
      ok: true, visibility, plan, reads: [], model: planned.model,
      answer: plan.note || "Nothing in the catalog answers that.",
      answeredFrom: "planner",
    });
  }

  const { reads, dropped } = await execute(plan);
  const answered = await callLLM(env, {
    system: ANSWER_SYSTEM,
    user: answerUser(question, reads),
    maxTokens: 700,
  });

  return json({
    ok: true,
    visibility,
    plan,
    dropped,
    // The reads travel WITH the answer on purpose: the digests are the evidence,
    // and a reader who wants to check the model can read exactly what it read.
    reads,
    model: answered?.model || planned.model,
    answer: answered?.parsed
      || "The reads succeeded but no provider was available to summarise them — the digests below are the raw answer.",
    answeredFrom: answered ? "llm" : "reads",
  });
}
