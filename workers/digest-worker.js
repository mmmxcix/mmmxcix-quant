// MMMXCIX Quant — Daily Digest Worker (standalone Cloudflare Worker, NOT a Pages Function).
//
// Sends a daily market-news digest email to all newsletter subscribers.
// Setup (KV binding, secrets, cron trigger): see workers/README.md.
//
// Bindings / secrets expected:
//   SUBSCRIBERS       — KV namespace (same one the Pages project uses for /api/subscribe)
//   RESEND_API_KEY    — Resend API key (secret)
//   DIGEST_FROM       — sender address, e.g. "MMMXCIX Quant <digest@mmmxcix.com>"
//   DIGEST_TEST_TOKEN — token for manual test runs via GET ?token=

const NEWS_URL = 'https://quant.mmmxcix.com/api/news';
const SITE_URL = 'https://quant.mmmxcix.com/news';
const CONFIRM_BASE = 'https://quant.mmmxcix.com/api/subscribe';
const RESEND_URL = 'https://api.resend.com/emails';
const MAX_ITEMS = 12;           // items in a "general" digest
const MAX_ITEMS_PER_TOPIC = 8;  // cap per category section in a personalized digest
const SEND_DELAY_MS = 600; // polite sequential sending (well under Resend rate limits)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateDe(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Zurich',
  });
}

// Fetch the FULL news list (each item carries source, category, access) so we
// can filter it per subscriber. No slicing here.
async function fetchAllNews() {
  const res = await fetch(NEWS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`news fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.items)) throw new Error('news feed returned no items');
  return data.items;
}

// Does a news item mention any of the subscriber's symbols? Matches the ticker
// (word-boundary) or the company/coin name (case-insensitive substring) in the
// item's title + description.
function matchesSymbols(item, symbols) {
  if (!symbols || symbols.length === 0) return false;
  const hay = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  for (const s of symbols) {
    const ticker = String(s.symbol || '').replace(/usdt$/i, '').toLowerCase();
    if (ticker.length >= 2 && new RegExp(`\\b${ticker.replace(/[^a-z0-9]/gi, '')}\\b`).test(hay)) return true;
    const name = String(s.name || '').toLowerCase().trim();
    if (name.length >= 3 && hay.includes(name)) return true;
  }
  return false;
}

// Build the personalized item set for one subscriber's prefs. Returns
// { sections: [{ label, items }] } — empty sections omitted.
function selectForPrefs(allItems, prefs) {
  const p = prefs || {};
  const freeOnly = p.freeOnly !== false;
  const sourceSet = Array.isArray(p.sources) && p.sources.length ? new Set(p.sources) : null;

  // Base pool honoring source + access filters.
  const pool = allItems.filter((it) => {
    if (freeOnly && it.access !== 'free') return false;
    if (sourceSet && !sourceSet.has(it.source)) return false;
    return true;
  });

  const categories = Array.isArray(p.categories) && p.categories.length ? p.categories : ['general'];
  const sections = [];
  const seen = new Set();

  const pushSection = (label, items) => {
    const unique = items.filter((it) => it.link && !seen.has(it.link));
    unique.forEach((it) => seen.add(it.link));
    if (unique.length) sections.push({ label, items: unique.slice(0, MAX_ITEMS_PER_TOPIC) });
  };

  if (categories.includes('portfolio') || categories.includes('watchlist')) {
    const label = categories.includes('portfolio') && categories.includes('watchlist')
      ? 'Your symbols' : categories.includes('portfolio') ? 'Your portfolio' : 'Your watchlist';
    pushSection(label, pool.filter((it) => matchesSymbols(it, p.symbols)));
  }
  if (categories.includes('general')) {
    pushSection('General finance news', pool.slice(0, MAX_ITEMS));
  }
  return { sections };
}

function groupBySource(items) {
  const groups = new Map();
  for (const item of items) {
    const source = item.source || 'Weitere';
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(item);
  }
  return groups;
}

// Build a personalized digest email from selected sections for one recipient.
function buildEmail(sections, date, email) {
  const dateStr = formatDateDe(date);
  const subject = `MMMXCIX Quant — Daily Market Digest (${dateStr})`;
  const unsubUrl = `${CONFIRM_BASE}?email=${encodeURIComponent(email)}`;

  // --- HTML version (dark-on-light, inline CSS only) ---
  let sectionsHtml = '';
  for (const section of sections) {
    const rows = section.items
      .map(
        (it) => `
          <tr>
            <td style="padding:6px 0 6px 0;">
              <a href="${escapeHtml(it.link)}"
                 style="color:#1a1a2e;font-size:15px;font-weight:600;text-decoration:none;line-height:1.4;">
                ${escapeHtml(it.title)}
              </a>
              <div style="font-size:11px;color:#9a9aae;margin-top:2px">${escapeHtml(it.source || '')}</div>
            </td>
          </tr>`
      )
      .join('');

    sectionsHtml += `
      <tr>
        <td style="padding:18px 0 4px 0;">
          <span style="display:inline-block;padding:2px 10px;border:1px solid #d0d0dc;border-radius:999px;
                       font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b6b80;">
            ${escapeHtml(section.label)}
          </span>
        </td>
      </tr>
      ${rows}`;
  }

  const html = `
<div style="background:#f4f4f7;padding:24px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e2ea;border-radius:12px;">
    <tr>
      <td style="padding:28px 28px 8px 28px;">
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6b6b80;">
          MMMXCIX Quant
        </div>
        <h1 style="margin:6px 0 0 0;font-size:20px;color:#1a1a2e;">
          Daily Market Digest
        </h1>
        <div style="margin-top:4px;font-size:13px;color:#6b6b80;">${escapeHtml(dateStr)}</div>
      </td>
    </tr>
    <tr>
      <td style="padding:8px 28px 24px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${sectionsHtml}
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 28px 24px 28px;border-top:1px solid #e2e2ea;">
        <p style="margin:0;font-size:12px;color:#6b6b80;line-height:1.6;">
          You're receiving this because you subscribed to and confirmed the MMMXCIX Daily Digest.
          <a href="${unsubUrl}" style="color:#1a1a2e;">Unsubscribe</a> ·
          <a href="${SITE_URL}" style="color:#1a1a2e;">more news</a>.
        </p>
      </td>
    </tr>
  </table>
</div>`;

  // --- Plain-text fallback ---
  let text = `MMMXCIX Quant — Daily Market Digest\n${dateStr}\n`;
  for (const section of sections) {
    text += `\n## ${section.label}\n`;
    for (const it of section.items) {
      text += `- ${it.title} (${it.source || ''})\n  ${it.link}\n`;
    }
  }
  text += `\n--\nUnsubscribe: ${unsubUrl}\nMore news: ${SITE_URL}\n`;

  return { subject, html, text };
}

// Confirmation (double opt-in) email — mirrors the one the Pages Function
// sends, used as a fallback for records that signed up while Resend wasn't
// configured on the Pages project.
function buildConfirmEmail(email, token) {
  const link = `${CONFIRM_BASE}?email=${encodeURIComponent(email)}&token=${token}`;
  const html =
    `<div style="background:#f4f4f7;padding:24px;font-family:system-ui,Segoe UI,sans-serif">` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e2ea;border-radius:12px">` +
    `<tr><td style="padding:28px">` +
    `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6b6b80">MMMXCIX Quant</div>` +
    `<h1 style="margin:6px 0 12px;font-size:20px;color:#1a1a2e">Confirm your subscription</h1>` +
    `<p style="color:#3a3a4a;font-size:14px;line-height:1.6">Please confirm your Daily Digest subscription:</p>` +
    `<p style="margin:20px 0"><a href="${link}" style="background:#1a1a2e;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-size:14px">Confirm subscription</a></p>` +
    `<p style="color:#6b6b80;font-size:12px">Didn't request this? Just ignore this email.</p>` +
    `</td></tr></table></div>`;
  return {
    subject: 'Confirm your MMMXCIX Quant Digest subscription',
    html,
    text: `Confirm your subscription: ${link}`,
  };
}

// Full subscriber records (parsed JSON), keyed by email.
async function listSubscriberRecords(kv) {
  const records = [];
  let cursor = undefined;
  do {
    const page = await kv.list({ prefix: 'sub:', cursor });
    for (const key of page.keys) {
      const email = key.name.slice('sub:'.length);
      const rec = await kv.get(key.name, 'json');
      if (rec && rec.email) records.push(rec);
      else records.push({ email, confirmed: true, prefs: { categories: ['general'], freeOnly: true } }); // legacy record
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records;
}

async function sendMail(env, to, mail) {
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.DIGEST_FROM, to: [to], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new Error(`resend HTTP ${res.status}`);
}

async function runDigest(env) {
  if (!env.SUBSCRIBERS) throw new Error('KV binding SUBSCRIBERS missing');
  if (!env.RESEND_API_KEY) throw new Error('secret RESEND_API_KEY missing');
  if (!env.DIGEST_FROM) throw new Error('secret DIGEST_FROM missing');

  const allItems = await fetchAllNews();
  const records = await listSubscriberRecords(env.SUBSCRIBERS);
  const now = new Date();

  let sent = 0, failed = 0, confirmSent = 0, skippedEmpty = 0;

  for (const rec of records) {
    try {
      // Unconfirmed: send a confirmation email (once), never the digest.
      if (!rec.confirmed) {
        if (!rec.confirmSentAt && rec.confirmToken) {
          await sendMail(env, rec.email, buildConfirmEmail(rec.email, rec.confirmToken));
          rec.confirmSentAt = now.toISOString();
          await env.SUBSCRIBERS.put(`sub:${rec.email}`, JSON.stringify(rec));
          confirmSent++;
          await sleep(SEND_DELAY_MS);
        }
        continue;
      }

      // Confirmed: build the personalized digest.
      const { sections } = selectForPrefs(allItems, rec.prefs);
      if (sections.length === 0) { skippedEmpty++; continue; } // nothing matched today
      await sendMail(env, rec.email, buildEmail(sections, now, rec.email));
      sent++;
      await sleep(SEND_DELAY_MS);
    } catch {
      failed++;
    }
  }

  return { subscribers: records.length, sent, failed, confirmSent, skippedEmpty, items: allItems.length };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runDigest(env));
  },

  // Manual test runs: GET https://<worker>/?token=<DIGEST_TEST_TOKEN>
  async fetch(request, env) {
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
        status: 405,
        headers: { 'content-type': 'application/json' },
      });
    }

    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!env.DIGEST_TEST_TOKEN || token !== env.DIGEST_TEST_TOKEN) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    try {
      const summary = await runDigest(env);
      return new Response(JSON.stringify({ status: 'ok', ...summary }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ status: 'error', message: String(err && err.message) }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
  },
};
