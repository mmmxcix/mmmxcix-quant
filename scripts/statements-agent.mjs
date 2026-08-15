// statements-agent.mjs — the live half: what is being said right now.
//
// Reads the two feeds the site already serves (/api/telegram for the OSINT
// squawk, /api/news for the RSS pool), finds the statements in them, assigns
// themes twice — once with the fixed lexicon, once with the local LLM — and
// pushes both to /api/statements.
//
// WHY BOTH CLASSIFIERS. The lexicon is what docs/STATEMENTS_FINDINGS.md was
// measured with, so it is the only assignment a number may ever be attached to.
// The model is recorded beside it, never substituted, and the disagreements are
// the cheapest evidence available that the fixed rules are drifting away from
// what the words mean. Same discipline as the Argus setup scorecard: recorded,
// not applied. See src/lib/statements/extract.js.
//
// It runs here rather than in a Worker because the model is the local OmniRoute
// router. Without LAB_LLM_URL the agent still runs and still stores everything —
// the lexicon needs no model, and the model column is simply left empty.
//
//   node scripts/statements-agent.mjs           # one pass
//   node scripts/statements-agent.mjs --dry     # parse and report, push nothing
//
// Env: LAB_TOKEN, LAB_SITE, LAB_LLM_URL, LAB_LLM_MODEL.

import { extractStatements } from "../src/lib/statements/parse.js";
import { themesFor } from "../src/lib/statements/themes.js";
import {
  parseRound1, parseRound2, reconcile, ROUND1_SYSTEM, ROUND2_SYSTEM, round1Prompt, round2Prompt,
} from "../src/lib/statements/extract.js";

const TOKEN = process.env.LAB_TOKEN || process.env.DEV_ACCESS_TOKEN || "";
const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const LLM_URL = (process.env.LAB_LLM_URL || "").replace(/\/+$/, "");
// NOT auto/best-* — those route to the strongest model available, which becomes
// the Claude subscription once it is connected. A feed poller would burn it.
const LLM_MODEL = process.env.LAB_LLM_MODEL || "groq/openai/gpt-oss-120b";
const DRY = process.argv.includes("--dry");

const stamp = () => new Date().toISOString();

async function getJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Both feeds, normalised to { id, text, time, channel, url }. */
async function feeds() {
  const out = [];
  const tg = await getJson(`${SITE}/api/telegram`);
  for (const it of tg?.items || []) {
    if (!it?.text || !Number.isFinite(it.time)) continue;
    // The permalink is a stable id; without one, the channel plus the minute is.
    const id = it.url ? `tg:${it.url.replace(/^https?:\/\/t\.me\//, "")}` : `tg:${it.channel}:${it.time}`;
    out.push({ id, text: it.text, time: it.time, channel: it.channel, url: it.url });
  }
  const news = await getJson(`${SITE}/api/news`);
  for (const it of news?.items || []) {
    const t = Date.parse(it?.pubDate || "");
    if (!it?.title || !Number.isFinite(t)) continue;
    out.push({
      id: `rss:${it.link || `${it.source}:${t}`}`.slice(0, 120),
      text: it.description ? `${it.title} — ${it.description}` : it.title,
      time: t, channel: it.source, url: it.link,
    });
  }
  return out;
}

async function callLLM(system, user) {
  if (!LLM_URL) return null;
  try {
    const r = await fetch(`${LLM_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL, stream: false, max_tokens: 3000, temperature: 0.1,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) return null;
    return (await r.json())?.choices?.[0]?.message?.content || null;
  } catch { return null; }
}

async function main() {
  if (!TOKEN && !DRY) { console.error("LAB_TOKEN is not set."); process.exit(1); }
  const items = await feeds();
  console.log(`[${stamp()}] feeds: ${items.length} items`);
  if (!items.length) return;

  // The measured path. `extractStatements` also collapses the desks' reposts,
  // which matters here as much as in the study — the same line arrives twice.
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = extractStatements(items).map((s) => {
    const src = byId.get(s.sourceId) || {};
    return {
      id: s.sourceId || `${s.channel || "feed"}:${s.at}`,
      at: s.at, speakerId: s.speakerId, speaker: s.speaker, role: s.role,
      quote: s.quote, subject: s.subject, channel: s.channel || src.channel, url: s.url || src.url,
      // Which population this row belongs to. The historical study measured the
      // WIRE desks only, so an RSS-sourced statement is stored and served but is
      // NOT covered by anything in docs/STATEMENTS_FINDINGS.md — a different
      // population with a different editorial filter and a different lag.
      sourceKind: String(s.sourceId || "").startsWith("rss:") ? "rss" : "wire",
      themes: themesFor(s), modelThemes: [], agreement: null, confidence: null, because: null,
    };
  });
  const wire = rows.filter((r) => r.sourceKind === "wire").length;
  console.log(`[${stamp()}] lexicon: ${rows.length} statements (${wire} wire, ${rows.length - wire} rss), ${rows.filter((r) => r.themes.length).length} themed`);

  // The recorded-not-applied path.
  if (LLM_URL && rows.length) {
    const r1 = await callLLM(ROUND1_SYSTEM, round1Prompt(items));
    const found = r1 ? parseRound1(r1, items) : [];
    const r2 = found.length ? await callLLM(ROUND2_SYSTEM, round2Prompt(found)) : null;
    const assigned = r2 ? parseRound2(r2, found) : [];
    // Joined by SOURCE ID, not by comparing prose: both sides clean the text
    // differently, so a substring match found nothing at all on the first run.
    const modelBySource = new Map();
    for (const a of assigned) {
      const f = found[a.idx];
      if (f?.source?.id) modelBySource.set(f.source.id, a);
    }
    let matched = 0, invented = 0;
    const seen = new Set();
    for (const row of rows) {
      const a = modelBySource.get(row.id);
      if (!a) continue;
      matched++;
      seen.add(row.id);
      invented += a.invented.length;
      const rec = reconcile({ lexiconThemes: row.themes, modelThemes: a.themes });
      row.modelThemes = rec.modelThemes;
      row.agreement = rec.agreement;
      row.confidence = a.confidence;
      row.because = a.because;
    }

    // Statements the model found and the LEXICON MISSED. These are stored with
    // an empty measured-theme list, because no statistic covers them — the study
    // never saw a statement the lexicon does not recognise. They are kept
    // precisely because they are the recall gap: the roster is 22 names and two
    // grammatical forms, and this is the only running record of what that misses.
    for (const a of assigned) {
      const f = found[a.idx];
      if (!f?.source?.id || seen.has(f.source.id)) continue;
      invented += a.invented.length;
      rows.push({
        id: f.source.id, at: f.source.time,
        speakerId: null, speaker: f.speaker, role: f.role,
        quote: f.quote, subject: null, channel: f.source.channel, url: f.source.url,
        sourceKind: String(f.source.id).startsWith("rss:") ? "rss" : "wire",
        themes: [], modelThemes: a.themes, agreement: "model-only",
        confidence: a.confidence, because: a.because,
      });
    }

    const agree = rows.filter((r) => r.agreement === "agree").length;
    const modelOnly = rows.filter((r) => r.agreement === "model-only").length;
    console.log(
      `[${stamp()}] model: ${found.length} statements found, ${matched} matched a lexicon row (${agree} agree), ` +
      `${modelOnly} the lexicon missed${invented ? `, ${invented} invented theme id(s) dropped` : ""}`
    );
  } else if (!LLM_URL) {
    console.log(`[${stamp()}] model: LAB_LLM_URL not set — lexicon only, which is the measured path anyway`);
  }

  if (DRY) {
    for (const r of rows.filter((x) => x.themes.length || x.modelThemes.length).slice(0, 14)) {
      const tag = r.themes.length ? r.themes.join(",") : `(model only: ${r.modelThemes.join(",") || "none"})`;
      console.log(`  ${new Date(r.at).toISOString().slice(0, 16)} ${r.sourceKind} ${r.speaker} [${tag}] ${r.quote.slice(0, 72)}`);
    }
    console.log(`[${stamp()}] dry run — nothing pushed`);
    return;
  }

  // Everything is stored, themed or not: a statement that matches no theme today
  // is still a row the next study gets to look at, and t.me only pages back as
  // far as the channel's own history.
  for (let i = 0; i < rows.length; i += 200) {
    const res = await fetch(`${SITE}/api/statements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, statements: rows.slice(i, i + 200) }),
      signal: AbortSignal.timeout(60_000),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) { console.error(`[${stamp()}] push failed: HTTP ${res.status} ${out.error || ""}`); return; }
    console.log(`[${stamp()}] pushed ${out.statements} statements`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
