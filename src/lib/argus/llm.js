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
const MODEL_CHAIN = [
  process.env.LAB_ARGUS_MODEL || "groq/llama-3.3-70b-versatile",
  ...(process.env.LAB_ARGUS_FALLBACKS || "auto/best-fast").split(",").map((s) => s.trim()),
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
    `CURRENTLY OPEN (do not duplicate): ${ctx.open.length ? ctx.open.join(", ") : "none"}\n\n` +
    "Return the JSON array now (or [] if nothing qualifies).";
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

async function callOnce(model, messages) {
  const res = await fetch(`${LLM_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: 900, temperature: 0.4, stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const content = j?.choices?.[0]?.message?.content || "";
  if (!content.trim()) throw new Error("empty response");
  return { content, model: j?.model || model };
}

/**
 * Generic one-shot chat over the same fallback chain — used by the Hermes
 * post-mortem (reflect.js), which needs its own system prompt rather than the
 * event-thesis one. Returns { ok, text, model?, error? }. Never throws.
 */
export async function chatOnce(messages, { maxTokens = 500, temperature = 0.3 } = {}) {
  let lastErr = "no model available";
  for (const model of MODEL_CHAIN) {
    try {
      const res = await fetch(`${LLM_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const text = j?.choices?.[0]?.message?.content || "";
      if (!text.trim()) throw new Error("empty response");
      return { ok: true, text, model: j?.model || model };
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
