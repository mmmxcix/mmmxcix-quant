// strategyName.js — turn a strategy into a clean, descriptive NAME.
//
// Cortex used to name strategies after the SOURCE ("Bitcoin looks like Google
// did in its early days", "DAX30 -LONG SET UP") because it fell back to the
// paper/reel title when the model omitted a name. This module fixes that at the
// root: it cleans a model-supplied name, rejects source-title / clickbait junk,
// and — when the name is bad or missing — DERIVES a name from what the code
// actually does (its indicators + direction). Pure ESM, no deps, so both the
// Node research agent and the Cloudflare Worker can share it.

// Phrases that mark a name as clickbait / commentary rather than a mechanism.
const JUNK_PHRASES = [
  "looks like", "early day", "new king", "is necessary", "set up", "set-up",
  "the time", "faces the", "key support", "holds key", "could", "here's",
  "why ", "how ", "this ", "watch ", "breaking", "alert", "!!", "🚀", "moon",
  "to the", "get rich", "secret", "genius", "insane", "crazy",
];

// Indicator / mechanism vocabulary, detected in the code to build a real name.
const INDICATORS = [
  [/\bmacd\b/i, "MACD"],
  [/\brsi\b/i, "RSI"],
  [/\badx\b/i, "ADX"],
  [/\batr\b/i, "ATR"],
  [/\bvwap\b/i, "VWAP"],
  [/\bsupertrend\b/i, "Supertrend"],
  [/\bbolling|bb_?(upper|lower|mid)|\bbband/i, "Bollinger"],
  [/\bdonchian\b/i, "Donchian"],
  [/\bkeltner\b/i, "Keltner"],
  [/\bstoch(astic)?\b/i, "Stochastic"],
  [/\bichimoku\b/i, "Ichimoku"],
  [/\bcci\b/i, "CCI"],
  [/\bobv\b/i, "OBV"],
  [/\bmfi\b/i, "MFI"],
  [/\broc\b/i, "ROC"],
  [/\bz[-_ ]?score\b/i, "Z-score"],
  [/\bema\b/i, "EMA"],
  [/\bsma\b/i, "SMA"],
  [/\bwma\b/i, "WMA"],
];

// Behaviour of the rule (how it trades), detected from code + edge text.
const BEHAVIOURS = [
  [/opening[-_ ]?range|(\borb\b)/i, "opening-range breakout"],
  [/mean[-_ ]?rever|revert|oversold|overbought/i, "mean-reversion"],
  [/breakout|break out|donchian|new high|new low/i, "breakout"],
  [/pullback|dip|retrace/i, "pullback"],
  [/divergen/i, "divergence"],
  [/squeeze/i, "squeeze"],
  [/momentum|roc\b|rate of change/i, "momentum"],
  [/cross(over|es|ing)?/i, "crossover"],
  [/trend|slope/i, "trend"],
];

function titleCase(s) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Does the code take short positions (so the name can say long/short)? */
function tradesShort(code) {
  const c = String(code || "");
  return /return\s*-1|signal\s*[:=]\s*-1|=\s*-1\b|["']short["']|["']sell["']|goShort|shortSignal/i.test(c);
}
function tradesLong(code) {
  const c = String(code || "");
  return /return\s+1\b|signal\s*[:=]\s*1\b|=\s*1\b|["']long["']|["']buy["']|goLong|longSignal/i.test(c);
}

/** Build a mechanism name from the code + optional edge text. */
export function describeStrategy(code, edge = "") {
  const hay = `${code || ""}\n${edge || ""}`;
  const inds = [];
  for (const [re, label] of INDICATORS) {
    if (re.test(hay) && !inds.includes(label)) inds.push(label);
    if (inds.length >= 3) break;
  }
  let behaviour = "";
  for (const [re, label] of BEHAVIOURS) { if (re.test(hay)) { behaviour = label; break; } }

  const short = tradesShort(code), long = tradesLong(code);
  const side = short && long ? "long/short" : short ? "short" : long ? "long" : "";

  let base;
  if (inds.length && behaviour) base = `${inds.slice(0, 2).join("/")} ${behaviour}`;
  else if (inds.length) base = `${inds.slice(0, 3).join("/")} rule`;
  else if (behaviour) base = titleCase(behaviour);
  else base = "Systematic rule";

  return side ? `${base} (${side})` : base;
}

/** True when a candidate name reads like a source title / hype, not a mechanism. */
function looksLikeJunk(name) {
  const n = String(name || "").trim();
  if (!n) return true;
  const low = n.toLowerCase();
  if (JUNK_PHRASES.some((p) => low.includes(p))) return true;
  // A long run of words with no indicator/mechanism term reads like a headline.
  const hasMechanism = INDICATORS.some(([re]) => re.test(n)) || BEHAVIOURS.some(([re]) => re.test(n));
  if (n.split(/\s+/).length > 7 && !hasMechanism) return true;
  // Shouty all-caps fragments ("DAX30 -LONG SET UP") — treat as a headline.
  if (/[A-Z]{2,}\s+-?[A-Z]{2,}/.test(n) && !hasMechanism) return true;
  return false;
}

// Strip provenance/emoji prefixes and a trailing "· SOURCE …" tail so we judge
// the core name. Keeps meaningful "· SYMBOL interval" tails intact only if the
// caller re-adds them; here we look at the head.
function stripDecoration(name) {
  return String(name || "")
    .replace(/^\s*\[[^\]]*\]\s*/g, "")            // "[research] " and similar
    .replace(/^\s*(🤖|✨|📈|🔥|⭐|🚀)\s*/gu, "")     // leading emoji badge
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Clean a strategy name: strip junk decoration; if the remainder is a source
 * title / clickbait (or empty), derive a mechanism name from the code instead.
 * @param {string} raw    model- or legacy-supplied name (may be junk)
 * @param {string} code   the strategy source (for the mechanism fallback)
 * @param {string} edge   optional EDGE comment text (extra signal for the fallback)
 */
export function cleanStrategyName(raw, code = "", edge = "") {
  const stripped = stripDecoration(raw);
  if (!looksLikeJunk(stripped)) return stripped.slice(0, 70);
  const described = describeStrategy(code, edge);
  // If even the code told us nothing and we had *some* stripped text, keep it
  // (a weak name beats "Systematic rule"); otherwise use the description.
  if (described === "Systematic rule" && stripped) return stripped.slice(0, 70);
  return described.slice(0, 70);
}
