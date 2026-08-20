// sources.mjs — where Cortex gets its ideas.
//
// The research agent used to read two APIs (arXiv, OpenAlex) and only ever saw
// ABSTRACTS. An abstract tells you *that* momentum works; the paper tells you
// *how* it was measured. So this module does two jobs:
//
//   1. harvestAll()   — pull candidate material from many free sources
//   2. fullTextOf()   — best-effort upgrade from abstract to actual body text
//
// Every source is best-effort and independently failure-isolated: a dead feed
// logs one line and returns [], it never takes the run down. That matters
// because this runs unattended at 3am.
//
// Deliberately NOT here: TikTok and Instagram. Both are login-walled and
// actively hostile to automation; a scraper for either breaks within weeks and
// fails *silently*, which is worse than not having the source. YouTube covers
// the video case via yt-dlp, which is a maintained tool that degrades loudly.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const UA = "mmmxcix-research/0.3 (+https://quant.mmmxcix.com)";
const MAILTO = "admin@mmmxcix.com";

// ── topic tagging & relevance ───────────────────────────────────────────────
// Topics do double duty: they gate which material is worth an LLM call, and
// they become the EDGES of the brain-vault knowledge graph.
export const TOPICS = [
  { name: "momentum", re: /\bmomentum\b/i },
  { name: "reversal", re: /reversal|mean.?reversion|overreaction/i },
  { name: "trend", re: /\btrend|breakout\b/i },
  { name: "volatility", re: /volatilit|garch|\bvix\b/i },
  { name: "seasonality", re: /seasonal|calendar effect|day.of.week|turn.of.month/i },
  { name: "factor", re: /\bfactor|cross.?section|anomal|alpha\b/i },
  { name: "intraday", re: /intraday|high.frequency|microstructure|order.?flow/i },
  { name: "pairs/arb", re: /pairs trading|cointegrat|stat.?arb|arbitrage/i },
  { name: "ml", re: /machine learning|neural|deep learning|reinforcement|lstm|transformer/i },
  { name: "risk", re: /drawdown|tail risk|hedg|value.at.risk|\bvar\b/i },
  { name: "prediction", re: /predict|forecast|drift|signal/i },
  { name: "options", re: /option|gamma|implied vol|straddle|greeks/i },
  { name: "execution", re: /slippage|execution|market impact|transaction cost/i },
];
export const topicsOf = (text) => TOPICS.filter((t) => t.re.test(text)).map((t) => t.name);

// Must clear this to be worth an LLM call. The old gate matched generic market
// words (price, stock, returns…) and let news/PR through — "X passes $1T",
// "Ex-CTO joins Y", "Market Alert" all reached the model. Now a METHOD term is
// required: the text has to look like it describes a tradable rule or a
// quantitative technique, not merely mention markets.
export const RELEVANCE =
  /\b(strateg\w*|backtest\w*|momentum|mean.?rever\w*|reversal|breakout|trend.?follow\w*|arbitrage|factor|alpha|signal\w*|indicator\w*|volatilit\w*|hedg\w*|quantitativ\w*|systematic|algorithmic|order.?(flow|book)|market.?mak\w*|portfolio\s+(optimi\w*|construct\w*|alloc\w*)|machine.?learning|reinforcement|neural|sharpe|drawdown|stat\w*.?arb\w*|pairs.?trad\w*|seasonal\w*|risk.?premi\w*|technical.?analysis|sector.?rotation|regime)\b/i;

// Hard blocklist on TITLES: news/PR/signal-spam that can contain method words
// but never contains a testable idea. Checked in addition to RELEVANCE.
export const JUNK =
  /^(buy|sell|long|short)\b|market alert|why stocks (are|were) moving|price (prediction|target)s?\b|passes \$|all.?time high|cumulative .{0,24}volume|hires|appoints|joins .{0,30} as|steps down|interview|opinion:|recap\b|market wrap|week ahead|top \d+|best \d+ |airdrop|presale|price analysis|price today|% indicator agreement|^\s*[a-z0-9]{2,12}(usdt?|perp)\b|forming (bullish|bearish)|is \$?\d[\d.,]*[km]? next|to the moon|-?\s*(long|short) set.?up\b/i;

// ── small helpers ───────────────────────────────────────────────────────────
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function getText(url, init = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, ...(init.headers || {}) },
    signal: AbortSignal.timeout(init.timeout ?? 20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
async function getJson(url, init = {}) {
  return JSON.parse(await getText(url, init));
}

/** Strip HTML to readable text. Crude on purpose — the LLM tolerates noise. */
function htmlToText(html) {
  return clean(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  );
}

/** Minimal RSS/Atom item parser — no dependency, tolerant of both dialects. */
function parseFeed(xml, sourceName) {
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? clean(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")) : "";
    };
    const title = htmlToText(pick("title"));
    if (!title) continue;
    // Atom puts the URL in an attribute rather than element text.
    let link = pick("link");
    if (!link) link = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    // content:encoded carries the FULL post on WordPress feeds (AlphaArchitect,
    // QuantInsti ship 17k–33k chars there); description is only the teaser.
    // Preferring description here silently threw away the entire article body —
    // and fetching the page instead is not an option, those hosts 403 us.
    const body = htmlToText(pick("content:encoded")) || htmlToText(pick("description") || pick("summary"));
    out.push({
      id: link || `${sourceName}:${title}`,
      title,
      abstract: body.slice(0, 2000), // short form: relevance + topic tagging
      body: body.slice(0, 14000),    // long form: what the LLM actually reads
      published: pick("pubDate") || pick("updated") || pick("published"),
      link,
      source: sourceName,
      kind: "article",
    });
  }
  return out;
}

// ── 1. arXiv ────────────────────────────────────────────────────────────────
async function arxiv(max) {
  const cats = ["q-fin.TR", "q-fin.PM", "q-fin.ST", "q-fin.CP", "q-fin.RM", "q-fin.MF"];
  const q = cats.map((c) => `cat:${c}`).join("+OR+");
  const xml = await getText(
    `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`
  );
  const out = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const pick = (tag) =>
      clean((block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]);
    const id = pick("id");
    if (!id) continue;
    out.push({
      id, title: pick("title"), abstract: pick("summary"),
      published: pick("published"), link: id, source: "arXiv", kind: "paper",
    });
  }
  return out;
}

// ── 2. OpenAlex ─────────────────────────────────────────────────────────────
// Abstracts arrive as an inverted index (word → positions); reconstruct them.
export function reconstructAbstract(inv) {
  if (!inv || typeof inv !== "object") return "";
  const words = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  return clean(words.join(" "));
}
async function openAlex(max) {
  const since = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10);
  const filter = `title_and_abstract.search:trading strategy,from_publication_date:${since}`;
  const data = await getJson(
    `https://api.openalex.org/works?filter=${filter.replace(/ /g, "%20")}&per-page=${max}&mailto=${MAILTO}`
  );
  return (data?.results || []).flatMap((w) => {
    const title = clean(w.title);
    if (!title) return [];
    const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, "") : "";
    return [{
      id: w.id, title, abstract: reconstructAbstract(w.abstract_inverted_index),
      published: w.publication_date || "", link: doi ? `https://doi.org/${doi}` : w.id,
      source: "OpenAlex", kind: "paper",
    }];
  });
}

// ── 2b. SSRN (via OpenAlex) ─────────────────────────────────────────────────
// "SSRN should become the natural starting point for every single trading
// strategy" — the reel is right: SSRN is where finance research lands first,
// often years before a journal. SSRN has no public API of its own, but
// OpenAlex fully indexes the SSRN Electronic Journal (S4210172589, 1.6M
// works) — so we harvest it through the same API with a source filter and
// let the usual RELEVANCE/JUNK screens do the topical filtering.
async function ssrn(max) {
  const since = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10);
  const filter = `primary_location.source.id:S4210172589,title_and_abstract.search:trading strategy,from_publication_date:${since}`;
  const data = await getJson(
    `https://api.openalex.org/works?filter=${filter.replace(/ /g, "%20")}&per-page=${max}&sort=publication_date:desc&mailto=${MAILTO}`
  );
  return (data?.results || []).flatMap((w) => {
    const title = clean(w.title);
    if (!title) return [];
    const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, "") : "";
    return [{
      id: w.id, title, abstract: reconstructAbstract(w.abstract_inverted_index),
      published: w.publication_date || "", link: doi ? `https://doi.org/${doi}` : w.id,
      source: "SSRN", kind: "paper",
    }];
  });
}

// ── 3. Crossref ─────────────────────────────────────────────────────────────
// 150M+ DOIs. Indexes journals and working papers (incl. much of SSRN) that
// OpenAlex ranks differently, so it genuinely widens the pool rather than
// re-returning the same works.
async function crossref(max) {
  const since = new Date(Date.now() - 540 * 864e5).toISOString().slice(0, 10);
  const url =
    `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent("trading strategy returns")}` +
    `&filter=from-pub-date:${since},type:journal-article&rows=${max}&sort=relevance&mailto=${MAILTO}`;
  const data = await getJson(url);
  return (data?.message?.items || []).flatMap((w) => {
    const title = clean((w.title || [])[0]);
    if (!title) return [];
    return [{
      id: w.DOI, title,
      abstract: htmlToText(w.abstract || "").replace(/^Abstract\s*/i, ""),
      published: (w.created?.["date-time"] || "").slice(0, 10),
      link: w.URL || `https://doi.org/${w.DOI}`, source: "Crossref", kind: "paper",
    }];
  });
}

// ── 4. Practitioner blogs (RSS) ─────────────────────────────────────────────
// Academia describes effects; practitioners describe implementations. This is
// where "how do I actually code the entry" tends to live.
const BLOGS = [
  { name: "AlphaArchitect", url: "https://alphaarchitect.com/feed/" },
  { name: "Quantpedia", url: "https://quantpedia.com/feed/" },
  { name: "RobotWealth", url: "https://robotwealth.com/feed/" },
  { name: "QuantInsti", url: "https://blog.quantinsti.com/rss/" },
  // NBER working papers — pre-journal economics, often the original source of
  // an anomaly years before it reaches a finance journal.
  { name: "NBER", url: "https://back.nber.org/rss/new.xml" },
];
/**
 * Feeds the discovery agent found on its own (~/.mmmxcix-sources.json).
 * Merged on top of the built-in list, so the system's reading grows without
 * anyone editing this file. Missing store = first run, not an error.
 */
const DISCOVERED_STORE = join(homedir(), ".mmmxcix-sources.json");
function discoveredFeeds() {
  try {
    const s = JSON.parse(readFileSync(DISCOVERED_STORE, "utf8"));
    return (s.feeds || []).filter((f) => f && f.url && (f.strikes || 0) < 5);
  } catch { return []; }
}

/**
 * Record which discovered feeds produced nothing, so discover-sources.mjs can
 * retire them. Without this the auto-discovered list rots exactly the way a
 * hand-maintained one does — it just rots without anyone watching.
 */
function recordYield(results) {
  try {
    const s = JSON.parse(readFileSync(DISCOVERED_STORE, "utf8"));
    let touched = false;
    for (const f of s.feeds || []) {
      if (!(f.name in results)) continue;
      const n = results[f.name];
      if (n > 0) { f.yield = (f.yield || 0) + n; f.strikes = 0; }
      else f.strikes = (f.strikes || 0) + 1;
      touched = true;
    }
    if (touched) writeFileSync(DISCOVERED_STORE, JSON.stringify(s, null, 2));
  } catch { /* no store yet */ }
}

async function blogs(max) {
  const all = [...BLOGS, ...discoveredFeeds().map((f) => ({ name: f.name, url: f.url, discovered: true }))];
  const per = Math.max(2, Math.ceil(max / Math.max(1, all.length)));
  const yields = {};
  const results = await Promise.all(
    all.map((b) =>
      getText(b.url)
        .then((xml) => {
          const items = parseFeed(xml, b.name).slice(0, per);
          if (b.discovered) yields[b.name] = items.length;
          return items;
        })
        .catch((e) => {
          console.error(`  ${b.name}: ${e.message}`);
          if (b.discovered) yields[b.name] = 0;
          return [];
        })
    )
  );
  recordYield(yields);
  const disc = all.filter((b) => b.discovered).length;
  if (disc) console.log(`  blogs: ${BLOGS.length} built-in + ${disc} self-discovered`);
  return results.flat();
}

// Exposed for the discovery agent, which has to parse and judge a feed before
// it is allowed into the rotation.
export const parseFeedPublic = parseFeed;
export const htmlToTextPublic = htmlToText;

// ── 5. Zenodo ───────────────────────────────────────────────────────────────
// Open-access repository (CERN-run), free and keyless. Carries preprints and
// independent research that never reaches a journal, so it surfaces material
// arXiv and Crossref both miss.
//
// Reddit used to sit in this slot and was removed: it now returns 403 to every
// non-OAuth client (both www and old), so it contributed nothing but an error
// line per run. Same reasoning that keeps TikTok/Instagram out — a source that
// silently yields zero is worse than one fewer source.
async function zenodo(max) {
  const d = await getJson(
    `https://zenodo.org/api/records?q=${encodeURIComponent('"trading strategy" OR "trading rule"')}` +
    `&size=${max}&sort=mostrecent`
  );
  return (d?.hits?.hits || []).flatMap((r) => {
    const md = r.metadata || {};
    const title = clean(md.title);
    if (!title) return [];
    return [{
      id: `zenodo:${r.id}`, title,
      abstract: htmlToText(md.description || "").slice(0, 2500),
      published: md.publication_date || "",
      link: r.doi_url || `https://zenodo.org/records/${r.id}`,
      source: "Zenodo", kind: "paper",
    }];
  });
}

// ── 6. Hacker News ──────────────────────────────────────────────────────────
async function hackerNews(max) {
  const d = await getJson(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent("trading strategy")}&tags=story&hitsPerPage=${max}`
  );
  return (d?.hits || []).flatMap((h) => {
    const title = clean(h.title);
    if (!title || !h.url) return [];
    return [{
      id: `hn:${h.objectID}`, title, abstract: clean(h.story_text || ""),
      published: (h.created_at || "").slice(0, 10),
      link: h.url, source: "HackerNews", kind: "article",
    }];
  });
}

// ── 7. YouTube (via yt-dlp) ─────────────────────────────────────────────────
// The video source that actually works unattended. yt-dlp is already on this
// machine (installed for the /watch skill). We only take the auto-caption
// transcript — no video is downloaded, so this is fast and light.
const YT_QUERIES = [
  "algorithmic trading strategy backtest results",
  "quantitative trading strategy explained",
  "trading strategy edge statistics",
];

async function ytdlp(args, timeout = 60000) {
  const { stdout } = await exec("yt-dlp", args, { timeout, maxBuffer: 12 * 1024 * 1024, windowsHide: true });
  return stdout;
}

async function youtube(max) {
  const perQuery = Math.max(1, Math.ceil(max / YT_QUERIES.length));
  const out = [];
  for (const q of YT_QUERIES) {
    try {
      const stdout = await ytdlp([
        `ytsearch${perQuery}:${q}`, "--dump-json", "--flat-playlist",
        "--no-warnings", "--quiet",
      ]);
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let v;
        try { v = JSON.parse(line); } catch { continue; }
        const title = clean(v.title);
        if (!title || !v.id) continue;
        // Skip shorts and multi-hour streams — neither yields a testable rule.
        const dur = v.duration || 0;
        if (dur && (dur < 120 || dur > 5400)) continue;
        out.push({
          id: `yt:${v.id}`, title,
          abstract: clean(v.description || "").slice(0, 1200),
          published: "", link: `https://www.youtube.com/watch?v=${v.id}`,
          source: "YouTube", kind: "video",
        });
      }
    } catch (e) {
      console.error(`  YouTube "${q.slice(0, 28)}…": ${e.message.slice(0, 60)}`);
    }
  }
  return out;
}

/** Auto-caption transcript for a YouTube id. Empty string if unavailable. */
async function youtubeTranscript(videoId) {
  const dir = mkdtempSync(join(tmpdir(), "cortex-yt-"));
  try {
    await ytdlp([
      "--skip-download", "--write-auto-subs", "--write-subs",
      "--sub-langs", "en.*,en", "--sub-format", "vtt",
      "-o", join(dir, "%(id)s"), "--no-warnings", "--quiet",
      `https://www.youtube.com/watch?v=${videoId}`,
    ], 90000);
    const vtt = readdirSync(dir).find((f) => f.endsWith(".vtt"));
    if (!vtt) return "";
    const raw = readFileSync(join(dir, vtt), "utf8");
    // Strip WEBVTT header, cue timings, and the duplicate rolling-caption lines
    // auto-subs are full of.
    const seen = new Set();
    const lines = [];
    for (const line of raw.split("\n")) {
      const t = clean(line.replace(/<[^>]+>/g, ""));
      if (!t || t === "WEBVTT" || /^\d+$/.test(t)) continue;
      if (/-->/.test(t) || /^(Kind|Language):/.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      lines.push(t);
    }
    return clean(lines.join(" "));
  } catch (e) {
    console.error(`  transcript ${videoId}: ${e.message.slice(0, 60)}`);
    return "";
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
  }
}

// ── full text ───────────────────────────────────────────────────────────────
/**
 * Best-effort upgrade from abstract to body text. This is the single biggest
 * quality lever in the pipeline: the abstract says an effect exists, the body
 * says how it was measured — lookback, rebalance, universe, thresholds.
 *
 * Returns "" when no better text is available; the caller falls back to the
 * abstract rather than failing.
 */
export async function fullTextOf(item, maxChars = 14000) {
  try {
    // Already carried inline by the feed (RSS content:encoded) — no fetch.
    if (item.body && item.body.length > 1500) return item.body.slice(0, maxChars);

    // arXiv serves an HTML rendering for most recent submissions — far lighter
    // than parsing the PDF. Roughly two thirds of papers have one; the rest
    // 404 and fall back to the abstract, which is fine.
    const ax = /arxiv\.org\/abs\/([^\s/v]+)/.exec(item.link || item.id || "");
    if (ax) {
      const html = await getText(`https://arxiv.org/html/${ax[1]}v1`, { timeout: 25000 }).catch(() => "");
      if (html) {
        const body = htmlToText(html);
        if (body.length > 3000) return body.slice(0, maxChars);
      }
    }

    if (item.kind === "video") {
      const id = String(item.id).replace(/^yt:/, "");
      const t = await youtubeTranscript(id);
      if (t.length > 800) return t.slice(0, maxChars);
    }
  } catch (e) {
    console.error(`  fulltext ${String(item.title).slice(0, 34)}: ${e.message.slice(0, 50)}`);
  }
  return "";
}

// ── orchestration ───────────────────────────────────────────────────────────
const SOURCES = [
  { name: "arXiv", fn: arxiv, weight: 1.5 },
  { name: "OpenAlex", fn: openAlex, weight: 1.0 },
  { name: "SSRN", fn: ssrn, weight: 1.1 }, // finance-first venue — slight preference
  { name: "Crossref", fn: crossref, weight: 1.0 },
  { name: "blogs", fn: blogs, weight: 1.0 },
  { name: "Zenodo", fn: zenodo, weight: 0.8 },
  { name: "HN", fn: hackerNews, weight: 0.5 },
  { name: "YouTube", fn: youtube, weight: 0.8 },
];

/**
 * Pull from every source in parallel, then interleave so no single source can
 * monopolise a run, dedupe by normalised title, and tag topics.
 *
 * @param {object} p
 * @param {number} [p.perSource]  base items requested per source
 * @param {string[]} [p.only]     restrict to these source names (debugging)
 */
export async function harvestAll({ perSource = 12, only = null } = {}) {
  const active = only ? SOURCES.filter((s) => only.includes(s.name)) : SOURCES;
  const settled = await Promise.all(
    active.map((s) =>
      s.fn(Math.max(2, Math.round(perSource * s.weight)))
        .then((items) => ({ name: s.name, items }))
        .catch((e) => { console.error(`${s.name}: ${e.message}`); return { name: s.name, items: [] }; })
    )
  );

  const counts = {};
  for (const { name, items } of settled) counts[name] = items.length;

  // Round-robin interleave so a 40-item arXiv pull can't bury a 3-item blog.
  const lists = settled.map((s) => s.items);
  const depth = Math.max(0, ...lists.map((l) => l.length));
  const seen = new Set();
  const merged = [];
  for (let i = 0; i < depth; i++) {
    for (const list of lists) {
      const p = list[i];
      if (!p) continue;
      const key = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 60);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...p, topics: topicsOf(`${p.title} ${p.abstract}`) });
    }
  }

  console.log(
    `sources: ${settled.map((s) => `${s.name} ${s.items.length}`).join(", ")} → ${merged.length} unique`
  );
  return { items: merged, counts };
}
