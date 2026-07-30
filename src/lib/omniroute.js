// omniroute.js — route the Backtest builder AI through the user's LOCAL OmniRoute
// (an OpenAI-compatible router, default http://localhost:3000/v1) instead of the
// Cloudflare provider chain. Free, and it uses whatever strong models OmniRoute
// aggregates — the same engine the Cortex and Argus agents already use.
//
// It works from the browser because the page and OmniRoute run on the SAME
// machine: Chrome/Firefox exempt http://localhost from https→http mixed-content
// blocking. OmniRoute must allow CORS for this origin (a one-line config).
//
// The prompts are composed server-side (promptOnly) and the raw output is
// finished server-side (postProcess), so a local generation is IDENTICAL to a
// server one — only the model in the middle changes. Everything falls back to
// the normal /api/generate path when OmniRoute is unreachable.

const LS_KEY = "quant_omniroute";

export function omniConfig() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "null") || {}; } catch { return {}; }
}
export function setOmniConfig(patch) {
  const next = { ...omniConfig(), ...patch };
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  return next;
}
export function omniEnabled() { return !!omniConfig().enabled; }
export const omniUrl = () => (omniConfig().url || "http://localhost:3000/v1").replace(/\/+$/, "");
export const omniModel = () => omniConfig().model || "auto/best-coding";
// The CLI shim (scripts/cli-llm-shim.mjs) — a LOCAL coding CLI on your Claude
// subscription, tried BEFORE OmniRoute so you get Opus without an API bill. Its
// own config, so only the builder uses it (background agents keep their OmniRoute).
export function cliEnabled() { return !!omniConfig().cliEnabled; }
export const cliUrl = () => (omniConfig().cliUrl || "http://localhost:8899/v1").replace(/\/+$/, "");
// The model to request on the CLI/subscription endpoint. If you connected Claude
// Code to OmniRoute, set url to your OmniRoute and this to that model's name — the
// background agents request different models, so only the builder hits it.
export const cliModel = () => omniConfig().cliModel || "cli";

/** Reachability probe with a short timeout — used to show status + decide fallback. */
export async function omniPing(url = omniUrl()) {
  try {
    const r = await fetch(`${url}/models`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

/**
 * Run one generation through OmniRoute. Returns the SAME shape as /api/generate
 * ({ code, language } | { review } | { critique }) or null on any failure (so the
 * caller cleanly falls back to the server chain).
 * @param {object} body  the normal /api/generate body (prompt | improve | review …)
 */
export async function omniGenerate(body, endpoint = null) {
  const url = (endpoint?.url || omniUrl());
  const model = (endpoint?.model || omniModel());
  // 1) Ask the server for the exact prompts it would use (no LLM spent).
  const pr = await fetch("/api/generate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, promptOnly: true }),
  });
  if (!pr.ok) return null;
  const { system, user, isCritique, language } = await pr.json();
  if (!system || !user) return null;

  // 2) Run them through the chosen local endpoint (CLI shim or OmniRoute).
  let text;
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.3, stream: false,
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    text = j?.choices?.[0]?.message?.content || "";
  } catch { return null; } // unreachable / CORS / timeout → fall back
  if (!text.trim()) return null;

  // 3) Finish it with the SAME server-side extraction as the normal path.
  const post = await fetch("/api/generate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ postProcess: { text, language, isCritique, review: !!body.review } }),
  });
  if (!post.ok) return null;
  return post.json();
}
