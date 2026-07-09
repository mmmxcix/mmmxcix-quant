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
//   plus AT LEAST ONE provider key:
//   ANTHROPIC_API_KEY  (Secret)  — sk-ant-... (paid, best quality)
//   GEMINI_API_KEY     (Secret)  — from aistudio.google.com (free tier)
// Anthropic is preferred when both are set.

const ANTHROPIC_MODEL = "claude-sonnet-5";
// Free-tier quotas differ wildly per model — on 429/404 we walk down this
// list instead of failing (flash-lite has the most generous free limits).
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];
const MAX_PROMPT_CHARS = 2000;

const SYSTEM_PROMPT = `You are a quant strategy generator for a browser-based backtesting tool.
Respond with JavaScript code ONLY — no markdown fences, no explanatory text before or after.

The code MUST define a function \`strategy(ctx)\`:
- ctx.candles: array of { time (unix seconds), open, high, low, close, volume }, ascending
- ctx.index: index of the current candle (the signal is computed on the close, executed at the next open)
- ctx.close: current close price
- ctx.position: "long" | "flat" (current position)
- ctx.indicators: { sma, ema, rsi, roc, atr, bollinger, donchian, closes }
  - sma/ema/rsi/roc(values, period) expect number[] (e.g. ctx.indicators.closes(ctx.candles))
  - atr/donchian(candles, period); bollinger(values, period, mult)
  - All return arrays the same length as the input, with null during the warm-up phase
- Return: "long" (hold/open a position) or "flat" (no position)

Rules:
- Long/flat only (no shorting). No look-ahead (use only data up to ctx.index).
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

  if (!env.DEV_ACCESS_TOKEN || (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY)) {
    return json({ error: "not_configured", hint: "Set DEV_ACCESS_TOKEN plus ANTHROPIC_API_KEY or GEMINI_API_KEY as Cloudflare secrets." }, 503);
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

  const prompt = String(body?.prompt || "").trim();
  if (!prompt) return json({ error: "empty_prompt" }, 400);
  if (prompt.length > MAX_PROMPT_CHARS) return json({ error: "prompt_too_long" }, 400);

  const userMsg = `Create a backtest strategy: ${prompt}`;
  let res, text;

  if (env.ANTHROPIC_API_KEY) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
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
    if (!res.ok) {
      // Never forward upstream error bodies — they can reference account details.
      return json({ error: res.status === 429 ? "rate_limited" : "upstream_error" }, res.status === 429 ? 429 : 502);
    }
    const data = await res.json();
    text = (data?.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    // Google Gemini (free tier) — key from aistudio.google.com. Sent via
    // header, not the URL, so it can never end up in logs of intermediaries.
    // Models are tried in order; 429/404 falls through to the next one.
    let lastStatus = 502;
    for (const model of GEMINI_MODELS) {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: userMsg }] }],
            generationConfig: { maxOutputTokens: 2500, temperature: 0.4 },
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        text = (data?.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || "")
          .join("\n");
        if (text) break;
        lastStatus = 502;
        continue;
      }
      lastStatus = res.status;
      if (res.status !== 429 && res.status !== 404) break; // real error — stop
    }
    if (!text) {
      return json({ error: lastStatus === 429 ? "rate_limited" : "upstream_error" }, lastStatus === 429 ? 429 : 502);
    }
  }

  if (!text) return json({ error: "empty_response" }, 502);
  return json({ code: extractCode(text) });
}
