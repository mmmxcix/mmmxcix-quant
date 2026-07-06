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
//   ANTHROPIC_API_KEY  (Secret)  — sk-ant-...
//   DEV_ACCESS_TOKEN   (Secret)  — long random string, shared only with devs

const MODEL = "claude-sonnet-5";
const MAX_PROMPT_CHARS = 2000;

const SYSTEM_PROMPT = `Du bist ein Quant-Strategie-Generator für ein Browser-Backtesting-Tool.
Antworte AUSSCHLIESSLICH mit JavaScript-Code, ohne Markdown-Zäune, ohne Erklärtext davor oder danach.

Der Code MUSS eine Funktion \`strategy(ctx)\` definieren:
- ctx.candles: Array von { time (Unix-Sekunden), open, high, low, close, volume }, aufsteigend
- ctx.index: Index der aktuellen Kerze (Signal wird auf Schlusskurs berechnet, Ausführung am nächsten Open)
- ctx.close: aktueller Schlusskurs
- ctx.position: "long" | "flat" (aktuelle Position)
- ctx.indicators: { sma, ema, rsi, roc, atr, bollinger, donchian, closes }
  - sma/ema/rsi/roc(values, period) erwarten number[] (z. B. ctx.indicators.closes(ctx.candles))
  - atr/donchian(candles, period); bollinger(values, period, mult)
  - Alle liefern Arrays gleicher Länge wie der Input, mit null in der Warmup-Phase
- Rückgabe: "long" (Position halten/eröffnen) oder "flat" (keine Position)

Regeln:
- Nur Long/Flat (kein Short). Kein Look-Ahead (nur Daten bis ctx.index verwenden).
- Indikator-Arrays einmal pro Kerzen-Array berechnen und cachen (z. B. Modul-Variable mit WeakMap oder Vergleich der Array-Referenz), damit der Backtest schnell bleibt.
- Defensive Checks auf null in der Warmup-Phase → dann "flat".
- Deutsche Kommentare, die die Logik knapp erklären.
- Kein Zugriff auf window/fetch/DOM — reine Berechnung.`;

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

  if (!env.ANTHROPIC_API_KEY || !env.DEV_ACCESS_TOKEN) {
    return json({ error: "not_configured", hint: "ANTHROPIC_API_KEY / DEV_ACCESS_TOKEN als Cloudflare-Secrets setzen." }, 503);
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

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Erstelle eine Backtest-Strategie: ${prompt}` }],
    }),
  });

  if (!res.ok) {
    // Never forward upstream error bodies — they can reference account details.
    const status = res.status === 429 ? 429 : 502;
    return json({ error: status === 429 ? "rate_limited" : "upstream_error" }, status);
  }

  const data = await res.json();
  const text = (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (!text) return json({ error: "empty_response" }, 502);

  return json({ code: extractCode(text) });
}
