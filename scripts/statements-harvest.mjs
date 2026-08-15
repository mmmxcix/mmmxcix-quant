// statements-harvest.mjs — the historical corpus of what important people said.
//
// The live feed (/api/telegram) answers "what is being said now". A study needs
// "what was said, for years, and what happened next" — and there is no archive
// endpoint for that. But the public Telegram preview pages BACKWARDS:
// `t.me/s/<channel>?before=<messageId>` returns the twenty messages before that
// id, all the way to the channel's first post. WalterBloomberg reaches back to
// February 2024 in ~34,000 messages, which is ~1,700 pages at one request a
// second: half an hour, once.
//
// Same split as the Form 4 project: the live path and the history path are
// different sources with different shapes, and pretending one can do the other's
// job is how a study ends up with three months of data.
//
//   node scripts/statements-harvest.mjs                       # all channels, to the start
//   node scripts/statements-harvest.mjs --channel financialjuice
//   node scripts/statements-harvest.mjs --pages 50            # a short probe
//
// Writes data/statements/<channel>.json (raw messages) — gitignored, rebuildable.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, "data", "statements");

// The two desks that write in the "SPEAKER: quote" house style. Others in
// /api/telegram's list are crypto or geopolitics feeds that rarely carry a
// sourced statement, so they would add volume and not events.
const CHANNELS = ["WalterBloomberg", "financialjuice"];

const PACE_MS = 1000;                    // one request a second — t.me is a courtesy, not an API
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function stripHtml(html) {
  return decodeEntities(String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Parse one preview page. Same regex family as functions/api/telegram.js — the
 * post id is taken too, because it is the paging cursor.
 */
function parsePage(html, channel) {
  const re = /data-post="[^/]+\/(\d+)"[\s\S]*?tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>[\s\S]*?tgme_widget_message_date[^>]*href="([^"]+)"[\s\S]*?datetime="([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const id = +m[1];
    const text = stripHtml(m[2]);
    const time = Date.parse(m[4]);
    if (Number.isFinite(id) && text.length > 4 && Number.isFinite(time)) {
      out.push({ id, channel, text: text.slice(0, 600), url: m[3], time });
    }
  }
  return out;
}

async function fetchPage(channel, before) {
  const url = before
    ? `https://t.me/s/${channel}?before=${before}`
    : `https://t.me/s/${channel}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; mmmxcix-quant/1.0)" },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
      if (!r.ok) return null;
      return parsePage(await r.text(), channel);
    } catch {
      await sleep(1500 * (attempt + 1));
    }
  }
  return null;
}

async function harvest(channel, maxPages) {
  const path = join(DIR, `${channel}.json`);
  // Resume rather than restart: a half-hour walk that has to begin again after
  // any interruption is a walk nobody finishes.
  const byId = new Map();
  if (existsSync(path)) {
    try {
      for (const m of JSON.parse(readFileSync(path, "utf8")).messages) byId.set(m.id, m);
      console.log(`${channel}: resuming with ${byId.size} messages already on disk`);
    } catch { /* corrupt — start over */ }
  }

  let before = null;
  // Walk back from the OLDEST id we already have, so a resume continues the walk
  // instead of re-reading the newest pages.
  if (byId.size) before = Math.min(...byId.keys());

  let pages = 0, added = 0;
  while (pages < maxPages) {
    const rows = await fetchPage(channel, before);
    pages++;
    if (!rows || !rows.length) {
      console.log(`${channel}: page ${pages} empty — reached the start of the channel`);
      break;
    }
    let fresh = 0;
    for (const m of rows) if (!byId.has(m.id)) { byId.set(m.id, m); fresh++; }
    added += fresh;
    const oldest = Math.min(...rows.map((r) => r.id));
    if (before !== null && oldest >= before) {
      console.log(`${channel}: cursor stopped moving at ${oldest} — done`);
      break;
    }
    before = oldest;
    if (pages % 25 === 0) {
      const d = new Date(Math.min(...rows.map((r) => r.time))).toISOString().slice(0, 10);
      console.log(`${channel}: ${pages} pages, ${byId.size} messages, back to ${d}`);
      save(path, channel, byId);
    }
    await sleep(PACE_MS);
  }
  save(path, channel, byId);
  const times = [...byId.values()].map((m) => m.time);
  console.log(
    `${channel}: ${byId.size} messages (+${added} this run), ` +
    `${new Date(Math.min(...times)).toISOString().slice(0, 10)} → ${new Date(Math.max(...times)).toISOString().slice(0, 10)}`
  );
  return byId.size;
}

function save(path, channel, byId) {
  const messages = [...byId.values()].sort((a, b) => a.id - b.id);
  writeFileSync(path, JSON.stringify({ channel, builtAt: Date.now(), messages }));
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const only = arg("channel", null);
  const maxPages = +arg("pages", 3000);
  for (const ch of only ? [only] : CHANNELS) {
    try { await harvest(ch, maxPages); } catch (e) { console.error(`${ch}: ${e.message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
