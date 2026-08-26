// argus/llm.js — the event channel's LLM call (Phase 1). Reads the alt-data
// briefing and proposes structured, event-driven trade theses via OmniRoute
// (OpenAI-compatible, default http://localhost:3000/v1). Parsing is pure and
// tested; the network call degrades gracefully when OmniRoute is down.
// See docs/DAYTRADER_AGENT.md.

const LLM_URL = (process.env.LAB_LLM_URL || "http://localhost:3000/v1").replace(/\/+$/, "");
// The models Argus requests from OmniRoute, tried in order until one answers.
//
// CRITICAL: never put `auto/best-*` here. Those meta-routes ask OmniRoute for the
// STRONGEST model available — which, once you connect Claude Code, is your Opus
// SUBSCRIPTION. Background agents must run on FREE models only, so this is an
// explicit list of free models (set via env), NOT a "best" route. If every free
// model is rate-limited the event channel just skips a cycle (best-effort).
//
// WHY THE CHAIN CHANGED, Aug 26 2026 (probed directly against the local
// OmniRoute). Every log line for weeks read "llm unavailable (empty response /
// timeout)", and there were TWO independent causes, either of which alone was
// fatal:
//
//   1. `groq/llama-3.3-70b-versatile` — the configured default — has been
//      DECOMMISSIONED and 404s on every request. The same groq key serves
//      `groq/openai/gpt-oss-20b` and `-120b` perfectly well.
//   2. OmniRoute answers with an SSE stream even when the request says
//      `stream: false`, so `res.json()` threw on a body beginning `data: {…}`
//      and the caller reported it as "empty response". A working model would
//      have failed in exactly the same way. See readCompletion below.
//
// The models here are gpt-oss REASONING models: they emit a `reasoning` field
// before any content, so a small max_tokens returns a technically-successful
// reply with an empty `content`. That is why the ceiling is 1500 and not 900 —
// measured, the reasoning alone runs 150-560 tokens on these prompts.
//
// Other providers in the router are NOT usable: cerebras, mistral and
// openrouter answer "No active credentials for provider", github-models is 410,
// ddgw fails its anti-abuse challenge. aug/cc/claude have live credentials and
// are the Claude subscription — never route a background agent there (below).
const MODEL_CHAIN = [
  process.env.LAB_ARGUS_MODEL || "groq/openai/gpt-oss-20b",
  // Fallbacks are explicit FREE models — never an `auto/*` route, so an agent
  // can never resolve to your Claude Code subscription in OmniRoute. Both were
  // verified answering this exact prompt shape on Aug 26 2026.
  ...(process.env.LAB_ARGUS_FALLBACKS || "groq/openai/gpt-oss-120b,nvidia/openai/gpt-oss-20b")
    .split(",").map((s) => s.trim()),
].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);

/** Robustly pull a JSON array of theses out of an LLM reply (fences, prose). */
export function parseTheses(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("["), end = t.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(t.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  // keep only well-formed, sane theses
  return arr
    .filter((x) => x && typeof x.symbol === "string" && (x.side === "long" || x.side === "short"))
    .map((x) => ({
      symbol: x.symbol.trim().toUpperCase(),
      side: x.side,
      thesis: String(x.thesis || "").slice(0, 400),
      invalidation: String(x.invalidation || "").slice(0, 300),
      confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0)),
      horizon: String(x.horizon || "").slice(0, 40),
      evidence: Array.isArray(x.evidence) ? x.evidence.slice(0, 6).map((e) => String(e).slice(0, 200)) : [],
    }))
    .slice(0, 3);
}

export function buildMessages(briefText, ctx) {
  const system =
    "You are a disciplined day-trading analyst for an EDUCATIONAL paper-trading agent. " +
    "From a market + alt-data briefing, propose 0-3 HIGH-CONVICTION, event-driven trade ideas on LIQUID, tradable instruments " +
    "(US stocks/ETFs like NVDA, SPY, QQQ, USO, XLE, ITA; or major crypto like BTCUSDT, ETHUSDT). " +
    "Bias: trade the CONTINUATION on confirmation — never chase the initial spike. Fade only an extreme overreaction. " +
    "Only propose a trade when there is a CLEAR catalyst AND a liquid instrument AND you can state what would INVALIDATE it. " +
    "Be skeptical: most briefings warrant []. Correlation is not causation. " +
    'Output STRICT JSON ONLY — an array of {"symbol","side":"long"|"short","thesis","invalidation","confidence":0..1,"horizon","evidence":[strings]}. No prose, no markdown.';
  const user =
    `BRIEFING:\n${briefText}\n\n` +
    `TRADABLE UNIVERSE (prefer these; you may name another liquid US ticker or major crypto if a catalyst clearly affects it): ${ctx.universe.join(", ")}\n` +
    (ctx.sectors && Object.keys(ctx.sectors).length
      // Route a single-stock catalyst to the CORRECT sector ETF (a utility like AEP
      // → XLU, never XLE/energy). Fixes the sector-hallucination bug.
      ? `SINGLE-STOCK → SECTOR ETF (if you trade the sector instead of the name, use the RIGHT one): ${Object.entries(ctx.sectors).map(([k, v]) => `${k}→${v}`).join(", ")}\n`
      : "") +
    `CURRENTLY OPEN (do not duplicate): ${ctx.open.length ? ctx.open.join(", ") : "none"}\n\n` +
    "Return the JSON array now (or [] if nothing qualifies).";
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/**
 * Read a completion body that may be EITHER a JSON object or an SSE stream.
 *
 * OmniRoute returns `text/event-stream` for several upstreams regardless of
 * `stream: false`, and the old code went straight to `res.json()`. That threw on
 * the leading `data: ` and every caller logged it as "empty response" — the
 * single most common line in this agent's history, on replies that were in fact
 * complete. Parsing both shapes is the whole fix.
 *
 * Exported so the tests can pin it: this used to be two unnamed lines that
 * nothing could reach.
 */
export function readCompletion(raw) {
  const text = String(raw || "");
  const pick = (o) => o?.delta?.content ?? o?.message?.content ?? "";
  if (!text.trimStart().startsWith("data:")) {
    let j;
    try { j = JSON.parse(text); } catch { throw new Error("unparseable response"); }
    if (j?.error) throw new Error(String(j.error?.message || j.error).slice(0, 160));
    return { content: pick(j?.choices?.[0]) || "", model: j?.model || null };
  }
  let content = "", model = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let j;
    try { j = JSON.parse(payload); } catch { continue; } // a split chunk, not a failure
    if (j?.error) throw new Error(String(j.error?.message || j.error).slice(0, 160));
    content += pick(j?.choices?.[0]) || "";
    model ||= j?.model || null;
  }
  return { content, model };
}

async function callOnce(model, messages, { maxTokens = 1500, temperature = 0.4, timeoutMs = 90_000 } = {}) {
  const res = await fetch(`${LLM_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const out = readCompletion(await res.text());
  if (!out.content.trim()) throw new Error("empty response");
  return { content: out.content, model: out.model || model };
}

/**
 * Generic one-shot chat over the same fallback chain — used by the Hermes
 * post-mortem (reflect.js), which needs its own system prompt rather than the
 * event-thesis one. Returns { ok, text, model?, error? }. Never throws.
 */
export async function chatOnce(messages, { maxTokens = 1200, temperature = 0.3 } = {}) {
  let lastErr = "no model available";
  for (const model of MODEL_CHAIN) {
    try {
      // Same transport as the event call. This used to carry its OWN copy of the
      // res.json() bug, so the Hermes post-mortems were failing silently for
      // exactly the same reason the theses were.
      const { content, model: served } = await callOnce(model, messages, { maxTokens, temperature, timeoutMs: 60_000 });
      return { ok: true, text: content, model: served };
    } catch (e) {
      lastErr = `${model}: ${String(e.message || e)}`;
    }
  }
  return { ok: false, text: "", error: lastErr };
}

/** Call OmniRoute for event theses, walking the model chain until one answers.
 *  Returns { ok, theses, raw?, model?, error? }. Never throws. */
export async function callArgusLLM(briefText, ctx) {
  const messages = buildMessages(briefText, ctx);
  let lastErr = "no model available";
  for (const model of MODEL_CHAIN) {
    try {
      const { content, model: served } = await callOnce(model, messages);
      return { ok: true, theses: parseTheses(content), raw: content, model: served };
    } catch (e) {
      lastErr = `${model}: ${String(e.message || e)}`;
    }
  }
  return { ok: false, theses: [], error: lastErr };
}
