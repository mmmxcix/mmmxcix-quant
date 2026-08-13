// /api/briefing — batched LLM synthesis for the news surface (email digest +
// the on-site News/Briefing tab share this ONE endpoint, so there is exactly
// one relevance/synthesis implementation instead of two).
//
// Fixes the "your portfolio" false-positive bug in the old digest matching
// (a bare `\bNOW\b` regex matched the English word "now", not ServiceNow):
// the deterministic ticker/name match here is only a RECALL-favoring candidate
// generator; when an LLM is available it CONFIRMS which candidates are
// actually about that company before anything is shown as "relevant". When no
// LLM is configured, the bare-ticker branch is dropped entirely and matching
// degrades to company-name-only (no stoplist to maintain, no bare "NOW").
//
// Same shape as functions/api/bias.js (its established pattern for this app):
// public, un-authenticated, rate-limited, free-tier-only provider chain
// (Groq/Gemini — no paid provider on a public path), D1-cached (~2h TTL),
// degrades to hasLLM:false rather than erroring. POST-only: both the on-site
// Briefing tab and the digest worker send a structured symbol list, which a
// GET query string can't carry cleanly.
//
// Body: { symbols: [{ market, symbol, name }, ...] }  (from distinctSymbols()
// client-side, or subscribe.js's stored prefs.symbols worker-side).

import { rateLimit, clientIp } from "../_lib/ratelimit.mjs";

const TTL_MS = 2 * 60 * 60 * 1000; // 2h — matches bias.js; news/fundamentals don't move minute-to-minute
// Fallback LIST like the Gemini one — Groq retires models on a schedule
// (llama-3.3-70b-versatile died Aug 2026 and silently killed all AI content
// while the key still read as "present"). Order = best first.
const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];
const MAX_TOKENS = 4000; // denser per-symbol writeups (see SYSTEM) need more room, esp. with 12 symbols in one call

const MAX_SYMBOLS_REQUEST = 40;   // defensive cap on the incoming list (candidate matching is cheap)
const MAX_SYMBOLS_ENRICHED = 12;  // only this many get an LLM/fundamentals pass per call (cost control)
const MAX_CANDIDATES_PER_SYMBOL = 6;
const MAX_GENERAL_POOL = 30;
const MAX_STORIES = 8;
const DESC_TRIM = 200;

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" },
  });
}

const SYSTEM = `You write a daily market briefing for an educational quant/trading tool. This is NOT investment advice.

You get: (1) a numbered pool of today's general finance/crypto headlines, and (2) for each of the reader's holdings/watchlist symbols, a numbered pool of CANDIDATE headlines that merely mention the symbol's ticker or company name somewhere in the text — some are genuinely about that company, many are false positives (the ticker word appearing incidentally — e.g. "NOW" the common English word inside an unrelated sentence, not ServiceNow the company). Your first job for each symbol is to tell the two apart.

Two tasks, STRICT JSON ONLY, no prose outside the JSON:

1. MARKET PULSE + TOP STORIES (only if a general headline pool is given below): write one short paragraph (2-3 sentences) on what's actually moving markets right now. Then pick up to ${MAX_STORIES} of the most significant general items by their given index and write a 2-3 sentence synthesis of each — what happened, why it matters, what to watch next. Quality over quantity; skip items that aren't actually significant.

2. PER-SYMBOL READ (for EVERY symbol listed below, whether or not it has candidate headlines): first, of that symbol's own candidates (if any), return the indices of ones that are genuinely BUSINESS/MARKET-RELEVANT news about that specific company/asset — a financial result, a product/deal/partnership, a regulatory or legal action, a leadership or strategy change, a material operational event. Drop anything incidental (a "top picks" roundup that merely mentions the ticker) AND drop anything that isn't actually investment-relevant even when the company or an executive genuinely IS the subject — pay-inequality studies, personal-life stories, culture/political commentary, celebrity coverage, etc. don't belong in a market briefing even if Company/CEO is the named subject; only include them if the piece is itself about company strategy, compensation-as-governance-news (e.g. a shareholder vote on pay), or a comparable material business matter. Then give a SHORT one-sentence "why" (a headline-style summary) AND a "keyFacts" array of 3-5 DISTINCT, concrete facts drawn from the confirmed headlines or fundamentals — each its own array item, each genuinely specific (a dollar amount, a percentage, a named executive or counterparty, a deal term, an earnings result, a real stated date or timeline). Never repeat or paraphrase the same fact twice across the array. If fewer than 3 genuinely distinct facts exist in the evidence, return fewer — never pad with a restatement or generic filler just to hit a count. If no headlines were confirmed, DO NOT go silent — ground why/keyFacts in the fundamentals given (sector, analyst rating/target, next earnings) framed honestly as a quiet-day status; keyFacts may be just 1-2 items in that case. Set "newsBased" true only when grounded in confirmed headlines, false when fundamentals-only. Also give a directional "stance" lean if the evidence actually supports one (default "neutral" otherwise), and a forward-looking "expectation" — an upcoming earnings date or analyst target IF given, or a specific near-term catalyst/timeline IF a headline states one, otherwise a realistic general thing to watch.

CRITICAL — every fact must come ONLY from the evidence given. Never invent a date, price, percentage, executive name, or any other specific you were not given, even to fill a natural-sounding gap (e.g. when will an acquisition close, what a target price "should" be). When the evidence doesn't specify something like that, SAY SO explicitly as a keyFacts item ("no confirmed closing date yet") — a stated gap is honest, a plausible-sounding guess is not, especially on a tool that is NOT investment advice.

Ground everything in the SPECIFIC evidence provided — no hallucinated facts, no generic platitudes.

Reply with STRICT JSON ONLY, exactly this shape (omit pulse/stories as null/[] if no general pool was given; include every symbol listed below, even with empty candidates):
{"pulse":{"summary":"...","tone":"up"|"down"|"mixed"}|null,
 "stories":[{"idx":0,"synthesis":"..."}],
 "symbols":{"TICKER":{"confirmedIdx":[0],"why":"..."|null,"keyFacts":["...","..."],"newsBased":true|false,"stance":"long"|"short"|"neutral","expectation":"..."|null}}}`;

function cleanSymbol(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 16);
}

function trim(str, n) {
  const s = String(str || "");
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

async function fetchNewsPool(origin) {
  try {
    const r = await fetch(`${origin}/api/news`);
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.items) ? d.items : [];
  } catch { return []; }
}

// Recall-favoring candidate generator (feeds the LLM confirmation step) — the
// bare ticker branch is intentionally over-inclusive here, that's fine because
// nothing downstream trusts it as "relevant" until confirmed.
function candidatesFor(items, symbol, name) {
  const ticker = symbol.replace(/USDT$/i, "").toLowerCase();
  const nm = String(name || "").toLowerCase().trim();
  const tickerRe = ticker.length >= 2 ? new RegExp(`\\b${ticker.replace(/[^a-z0-9]/gi, "")}\\b`) : null;
  return items
    .filter((it) => {
      const hay = `${it.title || ""} ${it.description || ""}`.toLowerCase();
      if (tickerRe && tickerRe.test(hay)) return true;
      if (nm.length >= 3 && hay.includes(nm)) return true;
      return false;
    })
    .slice(0, MAX_CANDIDATES_PER_SYMBOL);
}

// Merge two candidate lists (ticker-specific search first — that's the more
// targeted source), de-duping by link, capped to MAX_CANDIDATES_PER_SYMBOL.
function mergeCandidates(a, b) {
  const seen = new Set();
  const out = [];
  for (const it of [...a, ...b]) {
    if (!it.link || seen.has(it.link)) continue;
    seen.add(it.link);
    out.push(it);
    if (out.length >= MAX_CANDIDATES_PER_SYMBOL) break;
  }
  return out;
}

// No-LLM / beyond-enrichment-cap fallback: company NAME only, never the bare
// ticker — this is the actual fix for the "NOW" false-positive class when
// there's no LLM confirmation step available to catch it.
function deterministicRelevant(items, name) {
  const nm = String(name || "").toLowerCase().trim();
  if (nm.length < 3) return [];
  return items
    .filter((it) => `${it.title || ""} ${it.description || ""}`.toLowerCase().includes(nm))
    .slice(0, MAX_CANDIDATES_PER_SYMBOL)
    .map((it) => ({ title: it.title, link: it.link, source: it.source, pubDate: it.pubDate }));
}

async function fetchFundamentalsLite(origin, symbol) {
  try {
    const mods = "assetProfile,financialData,calendarEvents";
    const r = await fetch(`${origin}/api/yahoo/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${mods}`);
    if (!r.ok) return null;
    const m = (await r.json())?.quoteSummary?.result?.[0];
    if (!m) return null;
    const fd = m.financialData || {}, p = m.assetProfile || {}, ce = m.calendarEvents || {};
    const out = {
      sector: p.sectorDisp || p.sector || null,
      target: fd.targetMeanPrice?.raw ?? null,
      rating: fd.recommendationKey || null,
      nextEarnings: ce.earnings?.earningsDate?.[0]?.fmt || null,
    };
    return Object.values(out).some((v) => v != null) ? out : null;
  } catch { return null; }
}

// Ticker-specific search (same Yahoo endpoint + reasoning as bias.js's
// fetchTickerNews) — the general /api/news pool is 12 mainstream finance RSS
// feeds that essentially never cover small/micro-cap names, so a symbol like
// a quantum-computing or biotech micro-cap can have real, current news that
// never shows up as a candidate without this. Still just a CANDIDATE source —
// Yahoo tags a story with `relatedTickers` even when it's only tangentially
// about that symbol (e.g. a "top picks" roundup), so these go through the
// same LLM confirmation step as pool matches, never trusted outright.
async function fetchTickerNews(origin, symbol) {
  try {
    const r = await fetch(`${origin}/api/yahoo/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=8&quotesCount=0&enableFuzzyQuery=false`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d?.news || [])
      .filter((n) => n.title && n.link)
      .map((n) => ({
        title: n.title,
        link: n.link,
        source: n.publisher || "Yahoo Finance",
        pubDate: Number.isFinite(n.providerPublishTime) ? new Date(n.providerPublishTime * 1000).toISOString() : "",
      }));
  } catch { return []; }
}

// Provider chain — same free-tier-only reasoning as bias.js: this is a public,
// un-authenticated endpoint, so paid providers stay out of the chain (an
// attacker busting the cache shouldn't be able to run up paid-key spend).
async function callLLM(env, user) {
  const chain = [];
  if (env.GROQ_API_KEY) chain.push(async () => {
    for (const model of GROQ_MODELS) {
      // gpt-oss bills its chain-of-thought against max_tokens and returns it in
      // a separate field — keep the reasoning short so the budget goes to the
      // actual answer (see bias.js for the failure this prevents).
      const reasoner = /gpt-oss/i.test(model);
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model, max_tokens: MAX_TOKENS, temperature: 0.3,
          ...(reasoner ? { reasoning_effort: "low" } : {}),
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
        }),
      });
      if (r.ok) {
        const d = await r.json();
        const text = d?.choices?.[0]?.message?.content || "";
        if (text) return { text, model };
      } else if (r.status !== 429 && r.status !== 400 && r.status !== 404) break; // 400/404 = retired/unknown model → try the next
    }
    return null;
  });
  if (env.GEMINI_API_KEY) chain.push(async () => {
    for (const model of GEMINI_MODELS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.4 } }),
      });
      if (r.ok) {
        const d = await r.json();
        const text = (d?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n");
        if (text) return { text, model };
      } else if (r.status !== 429 && r.status !== 404) break;
    }
    return null;
  });
  for (const step of chain) {
    try { const out = await step(); if (out?.text) return out; } catch { /* next provider */ }
  }
  return null;
}

function buildPrompt(needMarket, generalPool, symbolBlocks) {
  const parts = [];
  if (needMarket && generalPool.length) {
    parts.push("GENERAL HEADLINES:\n" + generalPool.map((it, i) => `${i}: ${it.title} — ${it.source}`).join("\n"));
  }
  for (const b of symbolBlocks) {
    const lines = [`SYMBOL ${b.ticker} (${b.name || b.ticker}, ${b.market}):`];
    if (b.fundamentals) {
      const f = b.fundamentals;
      const fl = [];
      if (f.sector) fl.push(`sector ${f.sector}`);
      if (f.rating) fl.push(`analyst rating ${f.rating}`);
      if (f.target != null) fl.push(`mean target ${f.target}`);
      if (f.nextEarnings) fl.push(`next earnings ${f.nextEarnings}`);
      if (fl.length) lines.push(`Fundamentals: ${fl.join(", ")}`);
    }
    if (b.candidates.length) {
      lines.push("Candidate headlines:\n" + b.candidates.map((it, i) => {
        const desc = trim(it.description, DESC_TRIM);
        return desc ? `${i}: ${it.title} — ${desc}` : `${i}: ${it.title}`;
      }).join("\n"));
    } else {
      lines.push("Candidate headlines: (none found today)");
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

function parseBriefing(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function cacheHelpers(db) {
  const read = async (key) => {
    try { const row = await db?.prepare("SELECT data FROM argus_kv WHERE key=?").bind(key).first(); return row ? JSON.parse(row.data) : null; }
    catch { return null; }
  };
  const write = (key, obj) =>
    db?.prepare("INSERT INTO argus_kv (key,data,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
      .bind(key, JSON.stringify(obj), Date.now()).run();
  return { read, write };
}
const fresh = (row) => row && Date.now() - (row.at || 0) < TTL_MS;

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const reqSymbols = Array.isArray(payload?.symbols) ? payload.symbols.slice(0, MAX_SYMBOLS_REQUEST) : [];
  const clean = reqSymbols
    .map((s) => ({ market: s?.market === "crypto" ? "crypto" : "stock", symbol: cleanSymbol(s?.symbol), name: typeof s?.name === "string" ? s.name.slice(0, 80) : "" }))
    .filter((s) => s.symbol);
  // De-dupe by ticker, keep the first name seen for it.
  const bySymbol = new Map();
  for (const s of clean) if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, s);
  const symbols = [...bySymbol.values()];

  const db = env.DB;
  const { read, write } = cacheHelpers(db);

  const marketKey = "briefing:market";
  const cachedMarket = await read(marketKey);
  const needMarket = !fresh(cachedMarket);

  const symCache = new Map();
  const staleSymbols = [];
  for (const s of symbols.slice(0, MAX_SYMBOLS_ENRICHED)) {
    const row = await read(`briefing:sym:${s.symbol}`);
    if (fresh(row)) symCache.set(s.symbol, row);
    else staleSymbols.push(s);
  }
  // Anything beyond MAX_SYMBOLS_ENRICHED was never added to symCache above, so
  // it falls through to the deterministic branch in assemble() automatically.

  const needsWork = needMarket || staleSymbols.length > 0;
  const hasProvider = !!(env.GROQ_API_KEY || env.GEMINI_API_KEY);

  // Mirrors bias.js exactly: cached hits stay free/unlimited; only fresh LLM
  // work is rate-limited, so the per-symbol cache can't be busted into
  // unbounded provider calls.
  if (needsWork && hasProvider) {
    const rl = rateLimit(`briefing:${clientIp(request)}`, 8, 60_000);
    if (!rl.ok) {
      return json(assemble(cachedMarket, symCache, symbols, [], false, true), 200, 30);
    }
  }

  const url = new URL(request.url);
  const origin = /(^|\.)mmmxcix-quant\.pages\.dev$/.test(url.hostname) || url.hostname === "quant.mmmxcix.com"
    ? url.origin
    : (env.BETTER_AUTH_URL || "https://quant.mmmxcix.com");

  // Always fetched (not just when needsWork): /api/news is itself edge-cached
  // (5 min, see news.js) so this is cheap, and it's also what deterministic
  // fallbacks for cached-out/overflow symbols read from below.
  const newsPool = await fetchNewsPool(origin);

  let freshOut = null;
  if (needsWork && hasProvider && newsPool.length) {
    const generalPool = needMarket ? newsPool.slice(0, MAX_GENERAL_POOL) : [];
    const symbolBlocks = await Promise.all(staleSymbols.map(async (s) => {
      const poolCandidates = candidatesFor(newsPool, s.symbol, s.name);
      const [tickerNews, fundamentals] = await Promise.all([
        s.market === "crypto" ? Promise.resolve([]) : fetchTickerNews(origin, s.symbol),
        s.market === "crypto" ? Promise.resolve(null) : fetchFundamentalsLite(origin, s.symbol),
      ]);
      const candidates = mergeCandidates(tickerNews, poolCandidates);
      return { ticker: s.symbol, name: s.name, market: s.market, candidates, fundamentals };
    }));

    const user = buildPrompt(needMarket, generalPool, symbolBlocks);
    const out = await callLLM(env, user);
    const parsed = out ? parseBriefing(out.text) : null;

    if (parsed) {
      const now = Date.now();
      if (needMarket && parsed.pulse) {
        const tone = ["up", "down", "mixed"].includes(parsed.pulse.tone) ? parsed.pulse.tone : "mixed";
        const idxList = Array.isArray(parsed.stories) ? parsed.stories : [];
        const stories = idxList
          .filter((x) => Number.isInteger(x?.idx) && generalPool[x.idx])
          .slice(0, MAX_STORIES)
          .map((x) => {
            const it = generalPool[x.idx];
            return { title: it.title, link: it.link, source: it.source, pubDate: it.pubDate, category: it.category, synthesis: trim(x.synthesis, 400) };
          });
        const marketRow = { pulse: { summary: trim(parsed.pulse.summary, 500), tone }, stories, at: now };
        try { await write(marketKey, marketRow); } catch { /* best-effort */ }
        freshOut = freshOut || {};
        freshOut.market = marketRow;
      }
      for (const b of symbolBlocks) {
        const sym = parsed.symbols?.[b.ticker];
        if (!sym) continue;
        const idxList = Array.isArray(sym.confirmedIdx) ? sym.confirmedIdx : [];
        const relevantHeadlines = idxList
          .filter((i) => Number.isInteger(i) && b.candidates[i])
          .map((i) => { const it = b.candidates[i]; return { title: it.title, link: it.link, source: it.source, pubDate: it.pubDate }; });
        const stance = ["long", "short", "neutral"].includes(sym.stance) ? sym.stance : "neutral";
        const keyFacts = (Array.isArray(sym.keyFacts) ? sym.keyFacts : [])
          .filter((f) => typeof f === "string" && f.trim())
          .map((f) => trim(f, 200))
          .slice(0, 5);
        const symRow = {
          name: b.name, relevantHeadlines, stance,
          why: sym.why ? trim(sym.why, 200) : null,
          keyFacts,
          newsBased: !!sym.newsBased,
          expectation: sym.expectation ? trim(sym.expectation, 280) : null,
          enriched: true, at: now,
        };
        try { await write(`briefing:sym:${b.ticker}`, symRow); } catch { /* best-effort */ }
        symCache.set(b.ticker, symRow);
      }
    }
  }

  const marketRow = (freshOut && freshOut.market) || (fresh(cachedMarket) ? cachedMarket : null);
  return json(assemble(marketRow, symCache, symbols, newsPool, hasProvider, false));
}

// Assemble the response from whatever mix of cache/fresh/deterministic we have.
// Any symbol not in symCache (never checked because it's past the enrichment
// cap, or checked-and-missed with no fresh LLM result) falls back to the
// deterministic name-only match — never the bare-ticker regex, see top note.
function assemble(marketRow, symCache, symbols, newsPool, hasLLM, rateLimited) {
  const out = {
    ok: true, hasLLM: !!hasLLM, at: Date.now(),
    pulse: marketRow?.pulse || null,
    stories: marketRow?.stories || [],
    symbols: {},
  };
  if (rateLimited) out.rateLimited = true;

  for (const s of symbols) {
    const cached = symCache.get(s.symbol);
    out.symbols[s.symbol] = cached
      ? { name: cached.name || s.name, relevantHeadlines: cached.relevantHeadlines, stance: cached.stance, why: cached.why, keyFacts: cached.keyFacts || [], newsBased: !!cached.newsBased, expectation: cached.expectation, enriched: !!cached.enriched }
      : { name: s.name, relevantHeadlines: deterministicRelevant(newsPool, s.name), stance: "neutral", why: null, keyFacts: [], newsBased: false, expectation: null, enriched: false };
  }
  return out;
}
