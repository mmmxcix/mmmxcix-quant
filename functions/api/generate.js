// KI-Strategie-Generator — SECURITY-CRITICAL DESIGN NOTES:
//
// The Anthropic API key lives ONLY in Cloudflare (Pages → Settings →
// Environment variables, type "Secret"). It is read server-side from
// context.env and never appears in the client bundle, in responses, or in
// this repo. Access is gated by DEV_ACCESS_TOKEN (a second Cloudflare
// secret): without a matching token the function never talks to Anthropic.
// A future public paywall replaces the token check with purchased access
// tokens — the client contract stays identical.
//
// Required Cloudflare Pages env vars (Production):
//   DEV_ACCESS_TOKEN   (Secret)  — long random string, shared only with devs
//   plus AT LEAST ONE provider key. Tried in this fixed priority order, each
//   falling through to the next on ANY failure (rate limit, error, empty):
//   1. ANTHROPIC_API_KEY (Secret) — sk-ant-… (paid, best quality; optional)
//   2. MISTRAL_API_KEY   (Secret) — console.mistral.ai (FREE, code-specialised
//                                   Codestral; 1B tokens/month) — best free code
//   3. GROQ_API_KEY      (Secret) — console.groq.com (FREE, fast; 14,400/day)
//   4. GEMINI_API_KEY    (Secret) — aistudio.google.com (FREE, final fallback)
// All four are free to send public arXiv abstracts through — no secret or
// personal data ever enters a prompt (the dev token authenticates the endpoint
// only; the LLM sees the prompt, never the token).

const ANTHROPIC_MODEL = "claude-sonnet-5";
const MISTRAL_MODEL = "codestral-latest"; // Mistral's code-specialised model
const GROQ_MODEL = "llama-3.3-70b-versatile";
// Free-tier quotas differ wildly per model — on 429/404 we walk down this
// list instead of failing (flash-lite has the most generous free limits).
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];
const MAX_PROMPT_CHARS = 2000;
// Research documents (paper bodies, article text, video transcripts) are read
// whole rather than as abstracts, so they get their own, larger ceiling. Sized
// to stay comfortably inside the smallest provider context in the chain.
const MAX_RESEARCH_CHARS = 12000;

const SYSTEM_PROMPT = `You are a quant strategy generator for a browser-based backtesting tool.
Respond with JavaScript code ONLY — no markdown fences, no explanatory text before or after.

The code MUST define a function \`strategy(ctx)\`:
- ctx.candles: array of { time (unix seconds), open, high, low, close, volume }, ascending
- ctx.index: index of the current candle (the signal is computed on the close, executed at the next open)
- ctx.open / ctx.high / ctx.low / ctx.close: this bar's OHLC
- ctx.position: "long" | "short" | "flat" (current position)
- ctx.session: { hour, minute, minuteOfDay, isNewDay } — bar time in UTC, for intraday/session logic
- ctx.indicators: { sma, ema, rsi, roc, atr, bollinger, donchian, macd, closes }
  - closes(candles) → number[] of close prices. Pass it to the number-series indicators.
  - sma/ema/rsi/roc(values, period) → number[] — each element is a NUMBER (or null in warm-up)
  - atr(candles, period) → number[] — each element is a NUMBER (or null)
  - bollinger(values, period, mult) → array of OBJECTS: { upper, mid, lower } (or null). Compare price to bb[i].lower / bb[i].mid / bb[i].upper — NOT to bb[i] itself.
  - donchian(candles, period) → array of OBJECTS: { upper, lower } (or null). Use dc[i].upper / dc[i].lower — the prior-N-bar channel, excludes the current bar.
  - macd(values, fast, slow, signal) → array of OBJECTS: { macd, signal, hist } (or null). Use m[i].macd / m[i].signal / m[i].hist.
  - Every array is the same length as its input; entries are null during the warm-up phase.
  - CRITICAL: bollinger/donchian/macd elements are objects — comparing the whole element to a number (e.g. \`ctx.close < bb[i]\`) is a bug that silently never triggers. Always read the named field.
- Return one of:
  - "long" | "short" | "flat" (plain target position), or
  - { signal: "long"|"short"|"flat", stop: number, target: number } — stop/target are live
    bracket orders checked intrabar against high/low (stop fills before target if both hit).
    Return the same signal with new levels to trail a stop while holding.

Rules:
- The strategy must actually TRADE: both the entry and the exit condition have to
  realistically trigger on normal price data. A rule that enters once and never
  exits, or whose condition almost never occurs, is wrong — prefer crossovers,
  bands, and levels relative to recent data over rare absolute constants.
- No look-ahead (use only data up to ctx.index).
- The source is evaluated ONCE, then strategy(ctx) is called per bar in order — top-level
  let/const state persists across bars (useful for opening ranges, one-trade-per-day flags).
- Compute indicator arrays once per candle array and cache them (e.g. a module-level WeakMap or an array-reference check) to keep the backtest fast.
- Defensive null checks during the warm-up phase → return "flat".
- Concise English comments explaining the logic.
- No access to window/fetch/DOM — pure computation only.`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

// Constant-time-ish comparison — avoids trivially leaking token length/prefix
// through timing. (Cloudflare workers have no crypto.timingSafeEqual.)
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// Strip accidental markdown fences if the model adds them anyway.
function extractCode(text) {
  const fenced = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

// Rescue a common model quirk deterministically: sometimes the model emits only
// the BODY of the strategy — bare statements that use `ctx` and `return` — with
// no `function strategy(ctx){…}` wrapper, which then fails to compile. Rather
// than spend an LLM self-repair call on such a mechanical omission, wrap it.
// Strategies that already define strategy() (including ones with persistent
// top-level state) are left untouched.
function ensureStrategyFn(code) {
  const defined = /\bfunction\s+strategy\s*\(/.test(code) || /\b(?:const|let|var)\s+strategy\s*=/.test(code);
  if (defined) return code;
  // Only wrap something that actually looks like a per-bar body.
  if (/\bctx\b/.test(code) && /\breturn\b/.test(code)) {
    return `function strategy(ctx) {\n${code}\n}`;
  }
  return code; // not recognisable — let compile/repair handle it
}

// ── provider callers ────────────────────────────────────────────────────────
// Each returns { text } on success or { status } on failure. A caller never
// throws; the chain below walks to the next provider on any non-success.

async function callAnthropic(env, userMsg) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!res.ok) return { status: res.status };
  const data = await res.json();
  const text = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return text ? { text } : { status: 502 };
}

// Mistral and Groq both speak the OpenAI /chat/completions dialect, so one
// caller serves both — only base URL, key and model differ. The API key goes
// in the Authorization header (never the URL), so it can't leak into logs.
async function callOpenAICompatible(baseUrl, apiKey, model, userMsg) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
    }),
  });
  if (!res.ok) return { status: res.status };
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return text ? { text } : { status: 502 };
}

async function callGemini(env, userMsg) {
  // Models are tried in order; 429/404 falls through to the next one.
  let lastStatus = 502;
  for (const model of GEMINI_MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userMsg }] }],
          generationConfig: { maxOutputTokens: 2500, temperature: 0.4 },
        }),
      }
    );
    if (res.ok) {
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n");
      if (text) return { text };
      lastStatus = 502;
      continue;
    }
    lastStatus = res.status;
    if (res.status !== 429 && res.status !== 404) break; // real error — stop walking models
  }
  return { status: lastStatus };
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const hasProvider = env.ANTHROPIC_API_KEY || env.MISTRAL_API_KEY || env.GROQ_API_KEY || env.GEMINI_API_KEY;
  if (!env.DEV_ACCESS_TOKEN || !hasProvider) {
    return json({ error: "not_configured", hint: "Set DEV_ACCESS_TOKEN plus at least one provider key (MISTRAL_API_KEY, GROQ_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY) as Cloudflare secrets." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const token = String(body?.token || "");
  if (!safeEqual(token, env.DEV_ACCESS_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  // Cheap token check (no AI call) — used by the private Coach page gate.
  if (body?.validate === true) return json({ ok: true });

  // Four modes share the provider chain below:
  //  • repair:   fix code that failed to compile (bounded by code length, not the
  //              user-prompt cap, since generated code can be longer than a prompt).
  //  • research: distil a source DOCUMENT (paper body, article, video transcript)
  //              into one strategy. Also exempt from MAX_PROMPT_CHARS — the whole
  //              point is that a full text beats an abstract, and a 2000-char cap
  //              would truncate it back to abstract length. Still bounded, and
  //              still behind the same dev token.
  //  • critique: the committee's bear case. For a strategy that already SURVIVED
  //              the mathematical gauntlet, argue the other side — what regime
  //              breaks it, how confident we should be, and the explicit
  //              conditions under which it should be pulled. Returns prose (a
  //              structured verdict), not code, so it skips extractCode below.
  //  • generate: turn a natural-language request into a fresh strategy.
  const repair = body?.repair;
  const research = body?.research;
  const critique = body?.critique;
  const isCritique = !!(critique && typeof critique.code === "string");
  let userMsg;
  if (isCritique) {
    const code = critique.code.slice(0, 6000);
    const title = String(critique.title || "a strategy").slice(0, 200);
    const facts = String(critique.facts || "").slice(0, 800);
    userMsg =
      "You are the risk member of an investment committee. A candidate strategy has already PASSED " +
      "a rigorous statistical gauntlet (multi-market backtest, k-fold, noise test, out-of-sample " +
      "holdout, Deflated Sharpe). Your job is the BEAR CASE — argue against deploying it, so a human " +
      "can decide with both sides in front of them.\n\n" +
      `Strategy: "${title}"\n` +
      (facts ? `Validated facts: ${facts}\n` : "") +
      "\n```javascript\n" + code + "\n```\n\n" +
      "Reply with STRICT JSON, no prose outside it, exactly this shape:\n" +
      '{"bull":"<2-3 sentences: the strongest honest case FOR this strategy>",' +
      '"bear":"<2-3 sentences: the most likely way it fails in live trading — regime, crowding, cost, or fragility>",' +
      '"confidence":<integer 0-100: how likely this edge is real and persistent, not overfit>,' +
      '"regime":"<the market regime it depends on, e.g. trending / mean-reverting / high-vol>",' +
      '"invalidations":["<concrete condition to pull it, e.g. 3-month rolling Sharpe < 0>","<another>"]}\n' +
      "Be skeptical. A high confidence must be earned. Return ONLY the JSON object.";
  } else if (research && typeof research.text === "string") {
    const doc = research.text.slice(0, MAX_RESEARCH_CHARS);
    const title = String(research.title || "untitled").slice(0, 200);
    const kind = String(research.kind || "document").slice(0, 20);
    userMsg =
      `Source ${kind}: "${title}"\n\n` +
      `--- BEGIN SOURCE ---\n${doc}\n--- END SOURCE ---\n\n` +
      "Act as a hedge-fund quant. Turn the systematic idea in this source into ONE robust, testable " +
      "`strategy(ctx)`. Build it MULTI-FACTOR, not a single indicator — a single-indicator rule is fragile " +
      "and rarely survives real costs. Combine, where the source supports it:\n" +
      "  1. a REGIME / TREND filter that decides WHEN to be active (e.g. EMA slope, price vs a long SMA, " +
      "volatility band) — trade only in the conditions the edge needs, sit flat otherwise;\n" +
      "  2. an ENTRY trigger (the source's actual signal: a level, crossover, threshold);\n" +
      "  3. RISK MANAGEMENT: a stop-loss and take-profit via the bracket return " +
      "`{ signal, stop, target }`, sized from recent volatility (e.g. an ATR multiple), OR a clear exit rule.\n\n" +
      "Hard requirements (these are what separate a real edge from a backtest artifact):\n" +
      "  - It must be able to BEAT BUY & HOLD risk-adjusted — not just be profitable.\n" +
      "  - The edge must NOT depend on catching a move within a single bar; it must survive being executed " +
      "one bar late. Avoid entries that only work at an exact price touch.\n" +
      "  - Up to 5 parameters, hardcoded as const. Long and/or short. No look-ahead (only data up to ctx.index).\n\n" +
      "Start the code with 3 short comment lines: `// EDGE:` (why this has an edge, one sentence), " +
      "`// WORKS:` (the market regime/conditions it needs), `// BREAKS:` (what kills it). Then the code. " +
      "Prefer a rule the source actually states over one you invent. Name nothing after the source.";
  } else if (repair && typeof repair.code === "string") {
    const brokenCode = repair.code.slice(0, 8000);
    const err = String(repair.error || "unknown error").slice(0, 300);
    userMsg =
      `The following strategy code failed to compile with this error:\n"${err}"\n\n` +
      "Return a corrected version that satisfies ALL the rules above — in particular it MUST define " +
      "`function strategy(ctx)` (or `const strategy = (ctx) => { … }`). Change as little as possible and " +
      "keep the original trading logic; return ONLY the corrected JavaScript, no prose.\n\n" +
      "```javascript\n" + brokenCode + "\n```";
  } else {
    const prompt = String(body?.prompt || "").trim();
    if (!prompt) return json({ error: "empty_prompt" }, 400);
    if (prompt.length > MAX_PROMPT_CHARS) return json({ error: "prompt_too_long" }, 400);
    userMsg = `Create a backtest strategy: ${prompt}`;
  }

  // Fixed priority chain — best code model first, each falling through to the
  // next on ANY failure (rate limit, error, empty). Only keys that exist are
  // attempted, so the chain adapts to whichever secrets are set.
  const chain = [];
  if (env.ANTHROPIC_API_KEY) chain.push(() => callAnthropic(env, userMsg));
  if (env.MISTRAL_API_KEY) chain.push(() => callOpenAICompatible("https://api.mistral.ai/v1", env.MISTRAL_API_KEY, MISTRAL_MODEL, userMsg));
  if (env.GROQ_API_KEY) chain.push(() => callOpenAICompatible("https://api.groq.com/openai/v1", env.GROQ_API_KEY, GROQ_MODEL, userMsg));
  if (env.GEMINI_API_KEY) chain.push(() => callGemini(env, userMsg));

  let text = "";
  let lastStatus = 502;
  for (const attempt of chain) {
    let r;
    try {
      r = await attempt();
    } catch {
      lastStatus = 502; // network/parse fault — try the next provider
      continue;
    }
    if (r.text) { text = r.text; break; }
    lastStatus = r.status || 502;
  }

  if (!text) {
    // Never forward upstream error bodies — they can reference account details.
    return json({ error: lastStatus === 429 ? "rate_limited" : "upstream_error" }, lastStatus === 429 ? 429 : 502);
  }
  // The critique channel returns a structured verdict, not code. Parse the JSON
  // out of the model's reply defensively — models wrap it in prose or fences no
  // matter how firmly you ask them not to.
  if (isCritique) return json({ critique: parseVerdict(text) });
  return json({ code: ensureStrategyFn(extractCode(text)) });
}

// Pull the committee verdict JSON out of a model reply. Returns a normalised
// object (never throws) so a malformed reply degrades to a usable shell rather
// than failing the whole research run.
function parseVerdict(text) {
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
