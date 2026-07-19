// discover-sources.mjs — Cortex finds its own sources.
//
// Until now the source list was hand-written by a human and frozen in code.
// That is a ceiling: the system could only ever read what someone thought to
// give it, and a feed that died stayed in the list forever while a good new
// blog never entered it.
//
// This agent runs during the day and grows the list by itself:
//
//   1. SEED     take the topics the research agent is actually working on
//   2. SEARCH   look for feeds and repositories about those topics, via free
//               open catalogues (no API keys, no scraping)
//   3. PROBE    actually fetch each discovered feed and check it parses, is
//               recent, and is on-topic — a URL that looks like a quant blog
//               and returns 404 is worse than no URL
//   4. SCORE    rank by relevance × freshness × yield
//   5. PERSIST  write survivors to ~/.mmmxcix-sources.json, which sources.mjs
//               merges on top of its built-in list on every run
//
// Discovered sources are DEMOTED automatically too: anything that yields zero
// usable items on N consecutive harvests is retired. That is the half people
// forget, and it is why hand-maintained lists rot.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOPICS, RELEVANCE, parseFeedPublic, htmlToTextPublic } from "./sources.mjs";

const STORE = join(homedir(), ".mmmxcix-sources.json");
const RESEARCH_FILE = join(homedir(), ".mmmxcix-research.json");
const UA = "mmmxcix-research/0.3 (+https://quant.mmmxcix.com)";
const MAX_KEEP = 40;          // ceiling on discovered feeds we carry forward
const DEAD_STRIKES = 5;       // consecutive empty harvests before retirement

// ── store ───────────────────────────────────────────────────────────────────
export function loadSources() {
  try { return JSON.parse(readFileSync(STORE, "utf8")); }
  catch { return { feeds: [], lastDiscovery: 0, discoveries: 0 }; }
}
function saveSources(s) {
  try { writeFileSync(STORE, JSON.stringify(s, null, 2)); }
  catch (e) { console.error("source store save failed:", e.message); }
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function getText(url, timeout = 15000) {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
async function getJson(url, timeout = 15000) { return JSON.parse(await getText(url, timeout)); }

// ── 1. seeds: what is the agent actually interested in right now? ───────────
// Weighted by what is producing survivors, not by a fixed list — so the search
// follows the research where it is working.
function seedQueries() {
  const base = [
    "quantitative trading strategy blog",
    "algorithmic trading research",
    "systematic trading backtest",
    "quant finance research blog",
  ];
  try {
    const st = JSON.parse(readFileSync(RESEARCH_FILE, "utf8"));
    const counts = {};
    for (const c of [...(st.candidates || []), ...(st.graveyard || [])]) {
      for (const t of c.topics || []) counts[t] = (counts[t] || 0) + 1;
    }
    const hot = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
    for (const t of hot) base.push(`${t} trading strategy`);
  } catch { /* first run — base queries only */ }
  return base;
}

// ── 2. search: free, keyless catalogues ─────────────────────────────────────

/**
 * GitHub code/repo search — surfaces awesome-lists and research repos, which
 * are dense in links to blogs and papers. Unauthenticated is rate-limited to
 * 10 req/min, which is plenty for a once-a-day discovery pass.
 */
async function githubRepos(query) {
  try {
    const d = await getJson(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=8`
    );
    return (d?.items || []).map((r) => ({
      kind: "repo", title: clean(r.full_name), url: r.html_url,
      about: clean(r.description), stars: r.stargazers_count,
    }));
  } catch (e) { console.error(`  github "${query.slice(0, 26)}": ${e.message.slice(0, 50)}`); return []; }
}

/**
 * Hacker News is a surprisingly good discovery surface for quant blogs: posts
 * that reach the front page there are usually the ones worth subscribing to.
 * We take the DOMAIN, not the article — the goal is a durable feed.
 */
async function hnDomains(query) {
  try {
    const d = await getJson(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=25`
    );
    const domains = new Map();
    for (const h of d?.hits || []) {
      if (!h.url) continue;
      try {
        const host = new URL(h.url).origin;
        domains.set(host, (domains.get(host) || 0) + (h.points || 1));
      } catch { /* malformed url */ }
    }
    return [...domains.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([url, score]) => ({ kind: "site", title: new URL(url).hostname, url, score }));
  } catch (e) { console.error(`  hn "${query.slice(0, 26)}": ${e.message.slice(0, 50)}`); return []; }
}

/**
 * Mine a GitHub repo's README for outbound links.
 *
 * This is where the yield actually is. "awesome-quant" and its relatives are
 * hand-curated indexes of exactly the blogs and research sites we want, and
 * someone else already did the quality filtering. One README is worth more
 * than a dozen search queries — HN discovery alone returned a single usable
 * feed per run, which is not enough to call the system self-feeding.
 */
async function readmeLinks(repoUrl) {
  const m = /github\.com\/([^/]+)\/([^/]+)/.exec(repoUrl);
  if (!m) return [];
  const [, owner, repo] = m;
  for (const branch of ["main", "master"]) {
    for (const file of ["README.md", "readme.md"]) {
      try {
        const md = await getText(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}`, 20000);
        const urls = new Set();
        // Markdown links plus bare URLs.
        for (const mm of md.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) urls.add(mm[1]);
        for (const mm of md.matchAll(/(?:^|\s)(https?:\/\/[^\s)<>"']+)/g)) urls.add(mm[1]);
        return [...urls];
      } catch { /* try the next branch/filename */ }
    }
  }
  return [];
}

/** Hosts that are never a usable strategy-research feed. */
const HOST_DENY = /^(github\.com|raw\.githubusercontent\.com|gist\.github\.com|twitter\.com|x\.com|reddit\.com|youtube\.com|youtu\.be|linkedin\.com|facebook\.com|medium\.com|news\.ycombinator\.com|arxiv\.org|wikipedia\.org|en\.wikipedia\.org|doi\.org|pypi\.org|npmjs\.com|stackoverflow\.com|google\.com|docs\.google\.com|bloomberg\.com|ft\.com|wsj\.com|amazon\.|shields\.io|img\.shields\.io|travis-ci\.|codecov\.io|opensource\.org|creativecommons\.org|mailto)/i;

/**
 * Given a site, guess where its feed lives. Tries the HTML <link rel=alternate>
 * declaration first (authoritative), then the conventional paths.
 */
async function findFeed(siteUrl) {
  try {
    const html = await getText(siteUrl, 12000);
    const m = html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i);
    if (m) {
      const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1];
      if (href) return new URL(href, siteUrl).href;
    }
  } catch { /* fall through to conventional paths */ }
  for (const path of ["/feed/", "/feed", "/rss.xml", "/index.xml", "/atom.xml", "/feed.xml", "/rss"]) {
    try {
      const url = new URL(path, siteUrl).href;
      const xml = await getText(url, 10000);
      if (/<(rss|feed)\b/i.test(xml)) return url;
    } catch { /* try the next */ }
  }
  return null;
}

// ── 3. probe: does it actually work, and is it about our subject? ───────────
/**
 * A discovered URL is worthless until proven. This fetches it, parses it, and
 * scores the CONTENT — the single most common failure of auto-discovered feeds
 * is that they parse fine and are about something else entirely.
 */
async function probeFeed(url, name) {
  try {
    const xml = await getText(url, 15000);
    const items = parseFeedPublic(xml, name);
    if (items.length < 3) return { ok: false, why: `only ${items.length} items` };

    const onTopic = items.filter((i) => RELEVANCE.test(`${i.title} ${i.abstract}`));
    const relevance = onTopic.length / items.length;
    if (relevance < 0.25) return { ok: false, why: `off-topic (${Math.round(relevance * 100)}% relevant)` };

    // Freshness: a quant blog that last posted in 2019 is a museum.
    const dates = items.map((i) => Date.parse(i.published)).filter(Number.isFinite);
    const newest = dates.length ? Math.max(...dates) : 0;
    const ageDays = newest ? (Date.now() - newest) / 864e5 : 9999;
    if (ageDays > 400) return { ok: false, why: `stale (${Math.round(ageDays)}d old)` };

    // Does it carry full text, or only teasers? Full-text feeds are worth more.
    const fullText = items.filter((i) => (i.body || "").length > 1500).length / items.length;

    const topicHits = new Set();
    for (const i of onTopic) for (const t of TOPICS) if (t.re.test(`${i.title} ${i.abstract}`)) topicHits.add(t.name);

    const score = relevance * 60 + fullText * 25 + Math.max(0, 15 - ageDays / 30);
    return {
      ok: true, items: items.length, relevance: +relevance.toFixed(2),
      fullText: +fullText.toFixed(2), ageDays: Math.round(ageDays),
      topics: [...topicHits], score: +score.toFixed(1),
    };
  } catch (e) {
    return { ok: false, why: e.message.slice(0, 60) };
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const store = loadSources();
const known = new Set(store.feeds.map((f) => f.url));
// Never re-discover what is already built in.
const BUILTIN_HOSTS = new Set([
  "alphaarchitect.com", "quantpedia.com", "robotwealth.com", "blog.quantinsti.com", "back.nber.org",
]);

console.log(`discovery: ${store.feeds.length} known feeds, ${store.discoveries || 0} runs so far`);

const queries = seedQueries();
console.log(`seeds: ${queries.join(" · ")}`);

// Gather candidate sites.
const candidates = new Map(); // url -> {title, why}
for (const q of queries) {
  for (const hit of await hnDomains(q)) {
    try {
      const host = new URL(hit.url).hostname.replace(/^www\./, "");
      if (BUILTIN_HOSTS.has(host)) continue;
      // Skip the aggregators and paywalls that dominate HN but carry no feed
      // worth reading for strategy rules.
      if (/^(github\.com|twitter\.com|x\.com|reddit\.com|youtube\.com|medium\.com|news\.ycombinator\.com|arxiv\.org|wikipedia\.org|bloomberg\.com|ft\.com|wsj\.com)$/.test(host)) continue;
      if (!candidates.has(hit.url)) candidates.set(hit.url, { title: host, why: `HN ${q.slice(0, 24)}` });
    } catch { /* skip */ }
  }
}
// Curated GitHub lists are the richest vein: someone already filtered them.
// Search alone kept returning trading BOTS rather than link indexes, so the
// known-good indexes are named explicitly and search only supplements them.
const CURATED = [
  "https://github.com/wilsonfreitas/awesome-quant",
  "https://github.com/cbailes/awesome-deep-trading",
  "https://github.com/grananqvist/Awesome-Quant-Machine-Learning-Trading",
  "https://github.com/stefan-jansen/machine-learning-for-trading",
  "https://github.com/cantaro86/Financial-Models-Numerical-Methods",
  "https://github.com/PythonCharmers/awesome-python-finance",
];
const repoLeads = CURATED.map((url) => ({ url, title: url.split("/").slice(-2).join("/"), stars: null, curated: true }));
const seenRepo = new Set(CURATED);
for (const q of [...queries.slice(0, 3), "awesome quant", "awesome algorithmic trading"]) {
  for (const r of await githubRepos(q)) {
    if (r.stars < 150 || seenRepo.has(r.url)) continue;
    seenRepo.add(r.url);
    repoLeads.push({ url: r.url, title: r.title, stars: r.stars, about: r.about });
  }
}

// Mine the top lists' READMEs for outbound links, and treat each distinct host
// as a candidate site. This is what turns discovery from "one feed a day" into
// something that actually feeds itself.
let mined = 0;
for (const lead of repoLeads.slice(0, 10)) {
  const links = await readmeLinks(lead.url);
  mined += links.length;
  console.log(`  readme ${lead.title}: ${links.length} links`);
  for (const link of links) {
    try {
      const u = new URL(link);
      const host = u.hostname.replace(/^www\./, "");
      if (HOST_DENY.test(u.hostname) || BUILTIN_HOSTS.has(host)) continue;
      if (!/^https?:$/.test(u.protocol)) continue;
      const origin = u.origin;
      if (!candidates.has(origin)) candidates.set(origin, { title: host, why: `readme ${lead.title.slice(0, 28)}` });
    } catch { /* malformed */ }
  }
}

console.log(`candidates: ${candidates.size} sites (${mined} links mined from ${Math.min(6, repoLeads.length)} READMEs), ${repoLeads.length} repo leads`);

// Resolve feeds and probe them. Bounded and concurrent: feed discovery costs
// up to 7 HTTP round-trips per site, and a mined README can produce hundreds of
// hosts — unbounded this would run for hours and hammer strangers' servers.
const MAX_PROBE = +(process.env.LAB_DISCOVER_PROBE || 70);
const CONCURRENCY = 6;

// Sites already tried and rejected in a previous run are skipped, so each run
// explores NEW ground instead of re-probing the same dead hosts nightly.
const triedBefore = new Set(store.tried || []);
const queue = [...candidates.entries()]
  .filter(([url]) => !triedBefore.has(url))
  .slice(0, MAX_PROBE);

console.log(`probing ${queue.length} sites (${triedBefore.size} skipped as already tried)`);

const accepted = [];
const rejected = [];
const triedNow = [];

async function worker() {
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    const [siteUrl, meta] = next;
    triedNow.push(siteUrl);
    try {
      const feedUrl = await findFeed(siteUrl);
      if (!feedUrl) { rejected.push(`${meta.title}: no feed`); continue; }
      if (known.has(feedUrl)) continue;
      const probe = await probeFeed(feedUrl, meta.title);
      if (!probe.ok) { rejected.push(`${meta.title}: ${probe.why}`); continue; }
      accepted.push({
        name: meta.title, url: feedUrl, site: siteUrl,
        discoveredAt: Date.now(), discoveredVia: meta.why,
        score: probe.score, relevance: probe.relevance, fullText: probe.fullText,
        topics: probe.topics, strikes: 0, yield: 0,
      });
      console.log(`  ✓ ${meta.title} — score ${probe.score} (rel ${probe.relevance}, full ${probe.fullText}, ${probe.ageDays}d) via ${meta.why}`);
    } catch (e) {
      rejected.push(`${meta.title}: ${String(e.message).slice(0, 40)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

for (const r of rejected.slice(0, 10)) console.log(`  ✗ ${r}`);
if (rejected.length > 10) console.log(`  ✗ …and ${rejected.length - 10} more`);

// Merge, retire the dead, cap the list.
const merged = [...store.feeds];
for (const a of accepted) if (!merged.some((f) => f.url === a.url)) merged.push(a);

const before = merged.length;
const alive = merged.filter((f) => (f.strikes || 0) < DEAD_STRIKES);
const retired = before - alive.length;

alive.sort((a, b) => (b.score || 0) - (a.score || 0));
const kept = alive.slice(0, MAX_KEEP);

saveSources({
  feeds: kept,
  repoLeads: repoLeads.slice(0, 20),
  // Remember what we already probed so tomorrow's run explores new ground
  // rather than re-testing the same dead hosts forever. Bounded so the store
  // does not grow without limit.
  tried: [...new Set([...(store.tried || []), ...triedNow])].slice(-1500),
  lastDiscovery: Date.now(),
  discoveries: (store.discoveries || 0) + 1,
});

console.log(
  `\ndiscovery done: +${accepted.length} new, ${retired} retired, ${kept.length} active ` +
  `(store: ${STORE})`
);
if (accepted.length) {
  console.log("new sources will be picked up automatically on the next research run.");
}
