// /api/bias — the LLM enrichment layer for the "news & data" bias on Charts.
// The deterministic fundamental SCORE is computed client-side (src/lib/dataBias.js),
// always free; this endpoint adds ONE synthesised sentence + a per-horizon read from
// current fundamentals, live macro headlines and the model's knowledge. Cached per
// symbol in D1 (~2h) so it stays cheap under public traffic, and degrades to
// `note:null` when no LLM provider is configured (the client shows the score alone).
// GET is public (read, cached). Educational — not investment advice.

const TTL_MS = 2 * 60 * 60 * 1000;        // a symbol's fundamentals/news don't move minute-to-minute
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];
const ANTHROPIC_MODEL = "claude-sonnet-5";

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" },
  });
}

const SYSTEM =
  "You are a markets analyst writing a SHORT, balanced fundamental + news read for an educational charting tool. " +
  "This is NOT investment advice. Judge the likely directional lean on three horizons — short (days), medium (weeks), " +
  "long (months) — from the fundamentals and current headlines provided plus your general knowledge, and always name the " +
  "main risk to your view. Also give a concrete PRICE TARGET for each horizon: your single best point estimate of where " +
  "the price could realistically be, in the SAME units as the current price given below, grounded in the fundamentals, " +
  "analyst targets and headlines (not a wild guess — a considered estimate; null a horizon you genuinely can't call). " +
  "Reply with STRICT JSON ONLY: " +
  '{"shortTerm":"long"|"short"|"neutral","mediumTerm":"long"|"short"|"neutral","longTerm":"long"|"short"|"neutral",' +
  '"confidence":0..1,"note":"one or two plain sentences","drivers":["…","…"],' +
  '"targets":{"short":<price|null>,"medium":<price|null>,"long":<price|null>}}. ' +
  "`drivers` = up to 4 terse bullets (the concrete facts behind the read). No prose outside the JSON.";

async function fetchFundamentals(origin, symbol) {
  try {
    const mods = "assetProfile,defaultKeyStatistics,earningsHistory,financialData,calendarEvents";
    const r = await fetch(`${origin}/api/yahoo/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${mods}`);
    if (!r.ok) return null;
    const m = (await r.json())?.quoteSummary?.result?.[0];
    if (!m) return null;
    const fd = m.financialData || {}, ks = m.defaultKeyStatistics || {}, p = m.assetProfile || {}, ce = m.calendarEvents || {};
    const qs = ((m.earningsHistory || {}).history || [])
      .map((q) => (q.epsActual?.raw != null && q.epsEstimate?.raw != null ? (q.epsActual.raw >= q.epsEstimate.raw ? "beat" : "miss") : null))
      .filter(Boolean);
    return {
      sector: p.sectorDisp || p.sector || null,
      price: fd.currentPrice?.raw ?? null,
      target: fd.targetMeanPrice?.raw ?? null,
      rating: fd.recommendationKey || null,
      analysts: fd.numberOfAnalystOpinions?.raw ?? null,
      revGrowth: fd.revenueGrowth?.raw ?? null,
      margin: fd.profitMargins?.raw ?? null,
      forwardPE: ks.forwardPE?.raw ?? null,
      nextEarnings: ce.earnings?.earningsDate?.[0]?.fmt || null,
      streak: qs.slice(-4),
    };
  } catch { return null; }
}

async function fetchHeadlines(origin) {
  try {
    const r = await fetch(`${origin}/api/news`);
    if (!r.ok) return [];
    const d = await r.json();
    const items = d?.items || d?.headlines || d?.news || [];
    return items.map((x) => x.title || x.headline || x.text).filter(Boolean).slice(0, 6);
  } catch { return []; }
}

function evidence(market, symbol, f, headlines, price) {
  const L = [`Instrument: ${symbol} (${market})`];
  const px = price ?? f?.price;
  if (px != null) L.push(`Current price: ${px}`);
  if (market === "crypto") {
    L.push("No company fundamentals (a coin has no earnings). Weigh: macro liquidity & rates, regulation/ETF flows, BTC's lead, on-chain/adoption trends, and the current risk mood.");
  } else if (f) {
    if (f.sector) L.push(`Sector: ${f.sector}`);
    if (f.rating) L.push(`Analyst rating: ${f.rating}${f.analysts ? ` (${f.analysts} analysts)` : ""}`);
    if (f.target != null && f.price) L.push(`Price ${f.price.toFixed(2)} vs mean target ${f.target.toFixed(2)} (${((f.target / f.price - 1) * 100).toFixed(1)}% upside)`);
    if (f.streak?.length) L.push(`Last ${f.streak.length} quarters EPS: ${f.streak.join(", ")}`);
    if (f.revGrowth != null) L.push(`Revenue growth ${(f.revGrowth * 100).toFixed(1)}% yoy${f.margin != null ? `, profit margin ${(f.margin * 100).toFixed(0)}%` : ""}`);
    if (f.forwardPE != null) L.push(`Forward P/E ${f.forwardPE.toFixed(1)}`);
    if (f.nextEarnings) L.push(`Next earnings: ${f.nextEarnings}`);
  } else {
    L.push("(fundamentals unavailable — use general knowledge)");
  }
  if (headlines.length) L.push(`\nCurrent macro / market headlines:\n- ${headlines.join("\n- ")}`);
  return L.join("\n");
}

function parseBias(text, anchor) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let o; try { o = JSON.parse(t.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const dir = (v) => (["long", "short", "neutral"].includes(v) ? v : "neutral");
  // Accept a target only if it's a sane point estimate near the anchor (reject
  // hallucinated garbage — a 100× or negative "target" is noise, not analysis).
  const tgt = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || !(anchor > 0)) return null;
    return n >= anchor * 0.25 && n <= anchor * 4 ? n : null;
  };
  const tg = o.targets || {};
  return {
    horizon: { short: dir(o.shortTerm), medium: dir(o.mediumTerm), long: dir(o.longTerm) },
    confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0.5)),
    note: String(o.note || "").slice(0, 400),
    drivers: Array.isArray(o.drivers) ? o.drivers.map((d) => String(d).slice(0, 120)).slice(0, 4) : [],
    targets: { short: tgt(tg.short), medium: tgt(tg.medium), long: tgt(tg.long) },
  };
}

async function callLLM(env, user) {
  const chain = [];
  if (env.ANTHROPIC_API_KEY) chain.push(async () => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 700, system: SYSTEM, messages: [{ role: "user", content: user }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const text = (d?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return text ? { text, model: ANTHROPIC_MODEL } : null;
  });
  const oai = (base, key, model) => async () => {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 700, temperature: 0.3, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content || "";
    return text ? { text, model } : null;
  };
  if (env.GROQ_API_KEY) chain.push(oai("https://api.groq.com/openai/v1", env.GROQ_API_KEY, GROQ_MODEL));
  if (env.MISTRAL_API_KEY) chain.push(oai("https://api.mistral.ai/v1", env.MISTRAL_API_KEY, "mistral-large-latest"));
  if (env.GEMINI_API_KEY) chain.push(async () => {
    for (const model of GEMINI_MODELS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { maxOutputTokens: 700, temperature: 0.4 } }),
      });
      if (r.ok) { const d = await r.json(); const text = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n"); if (text) return { text, model }; }
      else if (r.status !== 429 && r.status !== 404) break;
    }
    return null;
  });
  for (const step of chain) { try { const out = await step(); if (out?.text) return out; } catch { /* next provider */ } }
  return null;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const market = url.searchParams.get("market") === "crypto" ? "crypto" : "stock";
  const symbol = String(url.searchParams.get("symbol") || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 16);
  if (!symbol) return json({ ok: false, error: "no_symbol" }, 400);

  const db = env.DB;
  const cacheKey = `biasv2:${market}:${symbol}`; // v2 adds price targets — orphan the pre-target cache
  const read = async () => { try { const row = await db?.prepare("SELECT data FROM argus_kv WHERE key=?").bind(cacheKey).first(); return row ? JSON.parse(row.data) : null; } catch { return null; } };
  const write = (obj) => db?.prepare("INSERT INTO argus_kv (key,data,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at").bind(cacheKey, JSON.stringify(obj), Date.now()).run();

  const cached = await read();
  if (cached && Date.now() - (cached.at || 0) < TTL_MS) {
    return json({ ...cached, cached: true }, 200, 600);
  }

  const hasProvider = env.ANTHROPIC_API_KEY || env.GROQ_API_KEY || env.MISTRAL_API_KEY || env.GEMINI_API_KEY;
  if (!hasProvider) return json({ ok: true, hasLLM: false, note: null, market, symbol });

  const origin = url.origin;
  const [f, headlines] = await Promise.all([
    market === "crypto" ? Promise.resolve(null) : fetchFundamentals(origin, symbol),
    fetchHeadlines(origin),
  ]);
  const priceParam = Number(url.searchParams.get("price"));
  const anchor = Number.isFinite(priceParam) && priceParam > 0 ? priceParam : (f?.price ?? 0);
  const out = await callLLM(env, evidence(market, symbol, f, headlines, anchor || null));
  const parsed = out ? parseBias(out.text, anchor) : null;
  if (!parsed) return json({ ok: true, hasLLM: !!out, note: null, market, symbol });

  const payload = { ok: true, hasLLM: true, market, symbol, anchorPrice: anchor || null, ...parsed, model: out.model, at: Date.now() };
  try { await write(payload); } catch { /* cache best-effort */ }
  return json({ ...payload, cached: false }, 200, 600);
}
