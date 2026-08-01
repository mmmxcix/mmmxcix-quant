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

import { isAdminRequest } from "../_lib/auth.mjs";

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

// Python variant — same tool, but the strategy is VECTORISED: it gets the whole
// OHLCV as a pandas DataFrame and returns one signal per bar, which the JS engine
// then fills (identical fees / next-open / no-look-ahead accounting).
const PYTHON_SYSTEM_PROMPT = `You are a quant strategy generator for a browser-based backtester that runs Python via Pyodide.
Respond with Python code ONLY — no markdown fences, no prose before or after.

The code MUST define \`def signals(df):\` returning one value per row of df:
- 1 = long, 0 = flat, -1 = short (a list, numpy array, or pandas Series, length == len(df)).
- df is a pandas DataFrame with columns: open, high, low, close, volume (one row per bar, ascending by time).
- numpy (np) and pandas (pd) are available. No other imports, no file/network access.

Rules:
- No look-ahead: row i may only use rows with index <= i. Use rolling()/shift() correctly — never .shift(-1).
- The signal at each bar is executed at the NEXT bar's open by the engine, so you do not model fills yourself.
- Prefer a MULTI-FACTOR rule (a trend/volatility filter that decides WHEN to be active, plus an entry trigger)
  over a single indicator — single-indicator rules are fragile and rarely beat buy & hold after costs.
- The edge must not depend on catching a move within one bar (it must survive being executed a bar late).
- Return 0 during warm-up (NaN indicator values) — fill NaNs with 0.
- Concise English comments. Keep it a single self-contained function plus its helpers.`;

const CPP_SYSTEM_PROMPT = `You are a quant strategy generator for a backtester that compiles and runs C++ natively (g++, -std=c++17).
Respond with C++ code ONLY — no markdown fences, no prose before or after.

The code MUST define exactly:
  struct Bar { double open, high, low, close, volume; };
  std::vector<int> signals(const std::vector<Bar>& bars);
returning one value per bar: 1 = long, 0 = flat, -1 = short (result size == bars.size()).

Rules:
- Standard headers only (<vector>, <cmath>, <deque>, etc.) — NO file/network/thread access, no main().
- No look-ahead: signal[i] may use only bars[0..i]. Compute indicators in a single forward pass where possible (this is the C++/HFT advantage — O(n), stateful, no re-scan).
- The signal at bar i is executed at bar i+1's open by the engine; do not model fills.
- Prefer a MULTI-FACTOR rule (a regime/volatility filter + an entry trigger) over a single indicator.
- Fill warm-up bars with 0. Keep it self-contained and O(n). Concise // comments.`;

const Q_SYSTEM_PROMPT = `You are a quant strategy generator for a backtester that runs kdb+/q natively.
Respond with q code ONLY — no markdown fences, no prose before or after.

The code MUST define exactly:  signals:{[t] ... }
where t is a table with columns \`open\`high\`low\`close\`volume (one row per bar, ascending by time),
returning a list of one value per row: 1 = long, 0 = flat, -1 = short (count matches count t).

Rules:
- Pure q/kdb+ (vector/columnar). No file/system access. Use moving windows (mavg, msum, prev, etc.).
- No look-ahead: row i may use only rows <= i (use prev/xprev and running aggregations, never next).
- The signal at row i is executed at row i+1's open by the engine; do not model fills.
- Prefer a multi-factor rule (a regime/volatility filter + an entry trigger). Fill warm-up rows with 0.
- Keep it a single self-contained function. Concise / comments.`;

// System prompt per target language.
const SYS_FOR = { js: SYSTEM_PROMPT, python: PYTHON_SYSTEM_PROMPT, cpp: CPP_SYSTEM_PROMPT, q: Q_SYSTEM_PROMPT };

// ── The quant knowledge every generation/improvement channel carries ────────
// Prepended to the improve/review prompts. Without it the model rewrites from
// vibes — that is how an "improvement" asked to CUT drawdown came back having
// doubled it. This is the working knowledge of a senior systematic researcher:
// what the goal actually is, the canonical strategy families and when each one
// works, the failure modes that make a backtest lie, and the mechanical bugs
// specific to this engine.
const QUANT_KNOWLEDGE = `
WHAT YOU ARE OPTIMISING FOR (in this order):
1. Risk-adjusted return that SURVIVES out-of-sample and after costs — Sharpe/Sortino, not raw return.
2. Beating buy & hold risk-adjusted over the same window. A strategy that trails simply holding the asset has no reason to exist.
3. A drawdown the account can actually sit through, and enough trades (≥30, ideally ≥100) for the result to mean anything.
Never buy one metric with another: cutting drawdown by barely trading, or lifting return by doubling drawdown, is not an improvement.

THE CANONICAL STRATEGY FAMILIES AND WHEN THEY WORK:
• Trend following (MA crossover, Donchian/Turtle channel breakout, Keltner breakout). Works in sustained directional markets with expanding volatility; bleeds in chop. Fix chop by filtering (only trade above a long SMA, or require an ADX/slope threshold) and by exiting on a shorter channel.
• Time-series (absolute) momentum: hold only while the asset's own trailing return is positive. The most robust single-asset factor; pairs naturally with a long-trend filter.
• Cross-sectional momentum / factor ranking (value, momentum, quality, low-volatility): rank a universe, long the top decile. Graded with Information Coefficient and Information Ratio, not just return.
• Mean reversion (RSI-2 / Connors, Bollinger fade, VWAP reversion). Works in ranging, high-liquidity, mean-reverting regimes and SHORT holding periods; catastrophic in a trending crash. Always require a trend filter (buy dips only above the SMA-200) and a hard stop — "it'll come back" is how accounts die.
• Volatility breakout / opening range (ORB, squeeze). Needs intraday data and a real session; scale the trigger to ATR, never a fixed number of points.
• Carry / seasonality / post-earnings drift (PEAD): slow, capacity-heavy edges that need long windows to show up.

REGIME AWARENESS (the single highest-value addition to most rules):
Most strategies are regime-conditional. A trend rule needs a trend; a fade needs a range. Add a filter that decides WHEN to be active — price vs a long SMA, EMA slope, ATR relative to its own average, realised volatility percentile — and sit flat outside it. That usually improves Sharpe and drawdown at once, without touching the entry logic.

RISK MANAGEMENT THAT ACTUALLY WORKS:
• Stops should be STRUCTURAL or volatility-scaled (a multiple of ATR, the other side of the range, a swing low) — never a fixed percentage. A fixed % stop is unrelated to how the market is moving, and a −2% loss needs more than +2% to recover.
• Size from the stop distance, not from a fixed lot: risk a small constant fraction of equity per trade.
• Volatility targeting (scale exposure by target-vol ÷ realised-vol) reduces drawdown more reliably than any entry tweak.
• Cap correlated exposure — three trades on the same driver is one trade at triple size.

HOW BACKTESTS LIE (check every one of these before claiming an improvement):
• Look-ahead: using a bar's own close to decide a trade filled at that close, or any .shift(-1). In this engine the signal on bar i executes at the OPEN of bar i+1 — an edge that dies with a one-bar delay was never real.
• Overfitting: many parameters, oddly specific thresholds, or a rule tuned until the equity curve looks good. Prefer round, defensible values and FEWER parameters. Every extra parameter needs its own justification.
• Too few trades: a 12-trade backtest is an anecdote. Wide confidence intervals, no statistical claim.
• Costs ignored: spread + fees + slippage kill most high-frequency "edges". If it only works at 0 bps, it doesn't work.
• Degenerate conditions: a rule that almost never triggers, or one that enters and never exits.
• Regime artefact: made all its money in one period (e.g. 2020) and flat since. Check the recent tail separately.

MECHANICAL BUGS SPECIFIC TO THIS ENGINE (fix on sight):
• Indicator warm-up returns null/NaN — guard it and return flat/0, never compare against null.
• bollinger/donchian/macd return OBJECTS: read bb[i].lower, dc[i].upper, m[i].macd. Comparing the whole element to a number silently never triggers.
• Donchian excludes the current bar — that is deliberate, don't "fix" it.
• Python: fill warm-up NaNs with 0, use rolling()/shift() correctly, never .shift(-1), and return exactly one value per row.
• Recompute indicator arrays once per candle array, not per bar.
`;

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

// Strip accidental markdown fences if the model adds them anyway. Any language
// tag after the opening fence (javascript / js / python / py …) is dropped.
function extractCode(text) {
  const fenced = text.match(/```[a-z]*\s*\n?([\s\S]*?)```/i);
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

async function callAnthropic(env, userMsg, system = SYSTEM_PROMPT) {
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
      system,
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
async function callOpenAICompatible(baseUrl, apiKey, model, userMsg, system = SYSTEM_PROMPT) {
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
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
    }),
  });
  if (!res.ok) return { status: res.status };
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || "";
  return text ? { text } : { status: 502 };
}

async function callGemini(env, userMsg, system = SYSTEM_PROMPT) {
  // Models are tried in order; 429/404 falls through to the next one.
  let lastStatus = 502;
  for (const model of GEMINI_MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
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
  if (!hasProvider) {
    return json({ error: "not_configured", hint: "Set at least one provider key (MISTRAL_API_KEY, GROQ_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY) as a Cloudflare secret." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  // Dual auth: the PC agents authenticate with the machine token
  // (DEV_ACCESS_TOKEN — server-to-server, no browser); humans authenticate with
  // their Better Auth ADMIN session cookie (the dev account). The old human
  // token-unlock flow is gone.
  const token = String(body?.token || "");
  const tokenOk = !!env.DEV_ACCESS_TOKEN && safeEqual(token, env.DEV_ACCESS_TOKEN);
  if (!tokenOk && !(await isAdminRequest(env, request))) {
    return json({ error: "unauthorized" }, 401);
  }

  // Cheap auth check (no AI call) — legacy probe, kept for compatibility.
  if (body?.validate === true) return json({ ok: true });

  // postProcess: the client ran the prompts through its OWN model (its local
  // OmniRoute) and hands back the raw text for the SAME server-side extraction
  // the provider chain would apply — so a browser-side/local generation is
  // finished identically (fence stripping, strategy() wrap, verdict parsing) and
  // no free/local model bypasses the post-processing. No AI call is made here.
  if (body?.postProcess && typeof body.postProcess.text === "string") {
    const { text, language, isCritique, review } = body.postProcess;
    if (isCritique) return json({ critique: parseVerdict(text) });
    if (review) return json({ review: String(text).trim().slice(0, 4000) });
    const out = extractCode(text);
    // ensureStrategyFn only makes sense for JS; python/cpp/q are returned as-is.
    const pl = String(language || "").toLowerCase();
    const native = pl === "python" || pl === "cpp" || pl === "q";
    return json({ code: native ? out : ensureStrategyFn(out), language: native ? pl : "js" });
  }

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
  const improve = body?.improve;
  const review = body?.review;
  const critique = body?.critique;
  const isCritique = !!(critique && typeof critique.code === "string");
  // Language of the generated strategy: Python (Pyodide, def signals(df)) or the
  // default JavaScript (strategy(ctx)). Honoured by generate, research AND repair
  // — a Python strategy that won't compile must be repaired AS Python, never
  // rewritten as JS. Critique returns a prose verdict, so language doesn't apply.
  const isPython = String(body?.language || "").toLowerCase() === "python" && !isCritique;
  // Full target language (js | python | cpp | q). C++/q run only on the native
  // executor; the system prompt + contract switch on this.
  const targetLang = isCritique ? "js" : (SYS_FOR[String(body?.language || "").toLowerCase()] ? String(body.language).toLowerCase() : "js");
  const isNative = targetLang === "cpp" || targetLang === "q";
  const langWord = targetLang === "cpp" ? "C++" : targetLang === "q" ? "q" : targetLang === "python" ? "Python" : "JavaScript";
  const contractLine = targetLang === "cpp"
    ? "define `std::vector<int> signals(const std::vector<Bar>& bars)` returning one value per bar (1 long / 0 flat / -1 short)"
    : "define `signals:{[t] ... }` returning one value per row of t (1 long / 0 flat / -1 short)";
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
    const head = `Source ${kind}: "${title}"\n\n--- BEGIN SOURCE ---\n${doc}\n--- END SOURCE ---\n\n`;
    userMsg = isNative
      ? head +
        `Act as a hedge-fund quant. Turn the systematic idea in this source into ONE robust, testable ${langWord} strategy ` +
        `that follows the system-prompt contract EXACTLY (${contractLine}). Make it MULTI-FACTOR — a regime/volatility ` +
        "filter deciding WHEN to be active PLUS an entry trigger, never a single indicator. Hard requirements: it must beat " +
        "buy & hold risk-adjusted; NO look-ahead (bar i uses only bars <= i); it must survive being executed one bar late; " +
        "up to 5 hardcoded parameters; long and/or short. Begin with 4 comment lines describing the RULE " +
        (targetLang === "cpp" ? "(`// NAME:` `// EDGE:` `// WORKS:` `// BREAKS:`)" : "(`/ NAME:` `/ EDGE:` `/ WORKS:` `/ BREAKS:`)") +
        " — name the MECHANISM, never the source article. Prefer a rule the source actually states over one you invent. " +
        `Output ONLY the ${langWord} code.`
      : isPython
      // Python: the strategy is VECTORISED — signals(df) returns one position per
      // bar (1/0/-1), no bracket orders (the engine handles fills), so the exit is
      // expressed as the signal returning to 0 or flipping, not a stop/target object.
      ? head +
        "Act as a hedge-fund quant. Turn the systematic idea in this source into ONE robust, testable " +
        "Python `def signals(df):` returning a pandas Series / numpy array of 1 (long) / 0 (flat) / -1 (short), " +
        "one value per row of df (columns: open, high, low, close, volume). Build it MULTI-FACTOR, not a single " +
        "indicator — a single-indicator rule is fragile and rarely survives real costs. Combine, where the source supports it:\n" +
        "  1. a REGIME / TREND filter that decides WHEN to be active (e.g. EMA slope, close vs a long rolling mean, " +
        "a volatility band) — be flat (0) outside the conditions the edge needs;\n" +
        "  2. an ENTRY trigger (the source's actual signal: a level, crossover, threshold) that sets +1/-1;\n" +
        "  3. an EXIT/RISK rule expressed in the signal itself (return to 0, or flip sign) — e.g. leave the trade " +
        "when the trend filter turns or a rolling stop level is breached. You cannot place stop/target orders; model risk by going flat.\n\n" +
        "Hard requirements (these separate a real edge from a backtest artifact):\n" +
        "  - It must be able to BEAT BUY & HOLD risk-adjusted — not just be profitable.\n" +
        "  - No look-ahead: row i may only use rows <= i. Use rolling()/shift() correctly; NEVER .shift(-1). Fill warm-up NaNs with 0.\n" +
        "  - The edge must survive being executed one bar late (no dependence on an exact single-bar touch).\n" +
        "  - Up to 5 parameters, hardcoded as constants. Long and/or short. numpy (np) + pandas (pd) only, no other imports.\n\n" +
        "Start the code with exactly 4 comment lines that describe the RULE, not vibes:\n" +
        "  `# NAME:` a short descriptive name for the STRATEGY itself (3-6 words, e.g. 'Volatility-filtered EMA pullback' or " +
        "'RSI-2 dip buy in uptrend'). Name the MECHANISM — never the source article, a ticker, or a headline.\n" +
        "  `# EDGE:` the concrete mechanism AND the actual rule — name the indicators, thresholds and directions you use " +
        "(e.g. 'long when close>SMA200 and RSI(2)<10, exit when close>SMA5 — buys short-term dips in an uptrend'); one sentence, specific enough to reproduce.\n" +
        "  `# WORKS:` the market regime/conditions it needs (trend vs chop, high/low volatility, session).\n" +
        "  `# BREAKS:` the concrete condition that kills it.\n" +
        "Do NOT write vague market commentary ('looks like', 'seems bullish', 'resembles X', 'recently') — state the systematic rule. Then the single self-contained " +
        "`def signals(df):` (plus any helpers). Prefer a rule the source actually states over one you invent. Name nothing after the source."
      : head +
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
        "Start the code with exactly 4 comment lines that describe the RULE, not vibes:\n" +
        "  `// NAME:` a short descriptive name for the STRATEGY itself (3-6 words, e.g. 'Volatility-filtered EMA pullback' or " +
        "'RSI-2 dip buy in uptrend'). Name the MECHANISM — never the source article, a ticker, or a headline.\n" +
        "  `// EDGE:` the concrete mechanism AND the actual rule — name the indicators, thresholds and directions you use " +
        "(e.g. 'long when EMA50>EMA200 and price reclaims VWAP, ATR stop + 2R target — trend-continuation entries'); one sentence, specific enough to reproduce.\n" +
        "  `// WORKS:` the market regime/conditions it needs (trend vs chop, high/low volatility, session).\n" +
        "  `// BREAKS:` the concrete condition that kills it.\n" +
        "Do NOT write vague market commentary ('looks like', 'seems bullish', 'resembles X', 'recently') — state the systematic rule. Then the code. " +
        "Prefer a rule the source actually states over one you invent. Name nothing after the source.";
  } else if (improve && typeof improve.code === "string") {
    // The always-on BUILD/IMPROVE loop: a strategy that traded but failed ONE
    // quality gate comes back with its specific failure; the model keeps the
    // core idea and fixes that weakness. Every attempt re-runs the full
    // gauntlet agent-side and counts as a trial.
    const baseCode = improve.code.slice(0, 8000);
    const facts = String(improve.facts || "").slice(0, 600);
    const title = String(improve.title || "a strategy").slice(0, 200);
    const hardReqs =
      "Hard requirements (unchanged):\n" +
      "  - It must be able to BEAT BUY & HOLD risk-adjusted — not just be profitable.\n" +
      "  - The edge must survive being executed one bar late (no dependence on an exact single-bar fill).\n" +
      "  - It must actually TRADE: entries AND exits trigger regularly on normal price data.\n" +
      "  - Up to 5 parameters, hardcoded. Long and/or short. No look-ahead.\n\n";
    userMsg = isNative
      ? `A previously generated ${langWord} strategy ("${title}") FAILED validation:\n${facts}\n\n` +
        "```\n" + baseCode + "\n```\n\n" +
        "Improve it: KEEP the core idea/edge, fix the specific weakness above. " + hardReqs +
        `Keep the ${langWord} contract (${contractLine}); no look-ahead. Update the NAME/EDGE/WORKS/BREAKS header to match. ` +
        `Return ONLY the corrected ${langWord}, no prose.`
      : isPython
      ? `A previously generated Python strategy ("${title}") FAILED validation:\n${facts}\n\n` +
        "```python\n" + baseCode + "\n```\n\n" +
        "Improve it: KEEP the core idea/edge, fix the specific weakness above. " + hardReqs +
        "Keep the `def signals(df):` contract (one value per row: 1 long / 0 flat / -1 short; " +
        "numpy+pandas only; rolling()/shift() correctly, never .shift(-1); warm-up NaNs → 0). " +
        "Update the `# EDGE:` / `# WORKS:` / `# BREAKS:` header to match the improved rule. " +
        "Return ONLY the corrected Python, no prose."
      : `A previously generated strategy ("${title}") FAILED validation:\n${facts}\n\n` +
        "```javascript\n" + baseCode + "\n```\n\n" +
        "Improve it: KEEP the core idea/edge, fix the specific weakness above. " + hardReqs +
        "Keep the `strategy(ctx)` contract. Update the `// EDGE:` / `// WORKS:` / `// BREAKS:` " +
        "header to match the improved rule. Return ONLY the corrected JavaScript, no prose.";
  } else if (repair && typeof repair.code === "string") {
    const brokenCode = repair.code.slice(0, 8000);
    const err = String(repair.error || "unknown error").slice(0, 300);
    userMsg = isNative
      ? `The following ${langWord} strategy failed with this error:\n"${err}"\n\n` +
        `Return a corrected version that MUST ${contractLine}. Change as little as possible and keep the original ` +
        `trading logic; return ONLY the corrected ${langWord}, no prose.\n\n` +
        "```\n" + brokenCode + "\n```"
      : isPython
      ? `The following Python strategy failed with this error:\n"${err}"\n\n` +
        "Return a corrected version that satisfies ALL the rules above — in particular it MUST define " +
        "`def signals(df):` returning one value per row (1 long / 0 flat / -1 short), length == len(df), NaNs filled with 0. " +
        "Change as little as possible and keep the original trading logic; return ONLY the corrected Python, no prose.\n\n" +
        "```python\n" + brokenCode + "\n```"
      : `The following strategy code failed to compile with this error:\n"${err}"\n\n` +
        "Return a corrected version that satisfies ALL the rules above — in particular it MUST define " +
        "`function strategy(ctx)` (or `const strategy = (ctx) => { … }`). Change as little as possible and " +
        "keep the original trading logic; return ONLY the corrected JavaScript, no prose.\n\n" +
        "```javascript\n" + brokenCode + "\n```";
  } else if (review && typeof review.code === "string") {
    // REVIEW: judge the code in the editor and say what to change — prose, not
    // code. The counterpart to `improve`, so a user can understand a strategy
    // (or their own edit) before letting the model rewrite it.
    const src = review.code.slice(0, 8000);
    const ask = String(review.prompt || "").trim().slice(0, 500);
    userMsg =
      `Review this ${isPython ? "Python signals(df)" : "JavaScript strategy(ctx)"} backtest strategy.\n\n` +
      "```\n" + src + "\n```\n\n" +
      (ask ? `The user specifically asks: ${ask}\n\n` : "") +
      "Answer as a hedge-fund quant reviewing a colleague's rule, in this order:\n" +
      "1. WHAT IT DOES — the actual rule in one or two sentences (entry, exit, filters), not a paraphrase of the comments.\n" +
      "2. EDGE — is there a plausible mechanism, or is it curve-fitting? Say plainly if you can't find one.\n" +
      "3. WEAKNESSES — concrete and specific: look-ahead, single-bar dependence (would it survive a 1-bar execution delay?), " +
      "too few/too many trades, parameter fragility, no risk exit, degenerate conditions that rarely trigger, costs ignored.\n" +
      "4. IMPROVE — the 2-4 highest-value changes, each one a concrete rule change (name indicators and thresholds), " +
      "ranked by how much it would improve risk-adjusted return.\n" +
      "Be honest and specific — if it looks unlikely to beat buy & hold after costs, say so. Plain prose, no code blocks, under 300 words.";
  } else {
    const prompt = String(body?.prompt || "").trim();
    if (!prompt) return json({ error: "empty_prompt" }, 400);
    if (prompt.length > MAX_PROMPT_CHARS) return json({ error: "prompt_too_long" }, 400);
    userMsg = `Create a backtest strategy: ${prompt}`;
  }

  // A review returns an assessment, so it must NOT be constrained by the
  // "reply with code only" system prompt. Both the review and the improve
  // channels carry the quant knowledge — they are the two that JUDGE an existing
  // strategy, which is exactly where domain knowledge decides the outcome.
  const system = review
    ? "You are a senior quantitative researcher reviewing backtest strategy code. You are candid, concrete and brief. " +
      "You never rewrite the code — you explain and advise.\n" + QUANT_KNOWLEDGE
    : improve
      ? SYS_FOR[targetLang] +
        "\n\nYou are a senior systematic researcher improving an existing strategy. Apply this knowledge:\n" + QUANT_KNOWLEDGE +
        "\nKeep the core idea. Change the fewest things that raise risk-adjusted return, and state nothing you did not actually implement."
      : SYS_FOR[targetLang];

  // promptOnly: hand the fully composed prompts to the caller instead of
  // executing them. The local research agent uses this to run generation
  // through its own LLM router (OmniRoute) — prompts stay defined in ONE
  // place (here) and no provider key ever leaves the server. Same auth as a
  // normal call, so the channel is exactly as private as execution.
  // NOTE: the agent post-processes with functions/_lib/codegen.mjs — kept in
  // sync with extractCode/ensureStrategyFn/parseVerdict below.
  if (body?.promptOnly) {
    return json({ system, user: userMsg, isCritique: !!isCritique, language: targetLang });
  }

  // Fixed priority chain — best code model first, each falling through to the
  // next on ANY failure (rate limit, error, empty). Only keys that exist are
  // attempted, so the chain adapts to whichever secrets are set.
  const chain = [];
  if (env.ANTHROPIC_API_KEY) chain.push(() => callAnthropic(env, userMsg, system));
  if (env.MISTRAL_API_KEY) chain.push(() => callOpenAICompatible("https://api.mistral.ai/v1", env.MISTRAL_API_KEY, MISTRAL_MODEL, userMsg, system));
  if (env.GROQ_API_KEY) chain.push(() => callOpenAICompatible("https://api.groq.com/openai/v1", env.GROQ_API_KEY, GROQ_MODEL, userMsg, system));
  if (env.GEMINI_API_KEY) chain.push(() => callGemini(env, userMsg, system));

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
  // A review is an assessment, not code — hand back the prose as-is.
  if (review) return json({ review: text.trim().slice(0, 4000) });
  // Python is returned as-is (the JS strategy(ctx) auto-wrap doesn't apply).
  const out = extractCode(text);
  return json({ code: targetLang === "js" ? ensureStrategyFn(out) : out, language: targetLang });
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
