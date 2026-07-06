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
const RESEND_URL = 'https://api.resend.com/emails';
const MAX_ITEMS = 12;
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
  return date.toLocaleDateString('de-DE', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Zurich',
  });
}

async function fetchTopNews() {
  const res = await fetch(NEWS_URL, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`news fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new Error('news feed returned no items');
  }
  return data.items.slice(0, MAX_ITEMS);
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

function buildEmail(items, date) {
  const groups = groupBySource(items);
  const dateStr = formatDateDe(date);
  const subject = `MMMXCIX Quant — Täglicher Markt-Digest (${dateStr})`;

  // --- HTML version (dark-on-light, inline CSS only) ---
  let sectionsHtml = '';
  for (const [source, groupItems] of groups) {
    const rows = groupItems
      .map(
        (it) => `
          <tr>
            <td style="padding:6px 0 6px 0;">
              <a href="${escapeHtml(it.link)}"
                 style="color:#1a1a2e;font-size:15px;font-weight:600;text-decoration:none;line-height:1.4;">
                ${escapeHtml(it.title)}
              </a>
            </td>
          </tr>`
      )
      .join('');

    sectionsHtml += `
      <tr>
        <td style="padding:18px 0 4px 0;">
          <span style="display:inline-block;padding:2px 10px;border:1px solid #d0d0dc;border-radius:999px;
                       font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b6b80;">
            ${escapeHtml(source)}
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
          Täglicher Markt-Digest
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
          Du erhältst diese Mail, weil du den MMMXCIX Daily Digest abonniert hast.
          Abbestellen oder mehr News: besuche
          <a href="${SITE_URL}" style="color:#1a1a2e;">quant.mmmxcix.com/news</a>.
        </p>
      </td>
    </tr>
  </table>
</div>`;

  // --- Plain-text fallback ---
  let text = `MMMXCIX Quant — Täglicher Markt-Digest\n${dateStr}\n`;
  for (const [source, groupItems] of groups) {
    text += `\n## ${source}\n`;
    for (const it of groupItems) {
      text += `- ${it.title}\n  ${it.link}\n`;
    }
  }
  text += `\n--\nAbbestellen oder mehr News: ${SITE_URL}\n`;

  return { subject, html, text };
}

async function listSubscribers(kv) {
  const emails = [];
  let cursor = undefined;
  do {
    const page = await kv.list({ prefix: 'sub:', cursor });
    for (const key of page.keys) {
      emails.push(key.name.slice('sub:'.length));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return emails;
}

async function sendOne(env, to, email) {
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.DIGEST_FROM,
      to: [to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });
  if (!res.ok) {
    throw new Error(`resend HTTP ${res.status}`);
  }
}

async function runDigest(env) {
  if (!env.SUBSCRIBERS) throw new Error('KV binding SUBSCRIBERS missing');
  if (!env.RESEND_API_KEY) throw new Error('secret RESEND_API_KEY missing');
  if (!env.DIGEST_FROM) throw new Error('secret DIGEST_FROM missing');

  const items = await fetchTopNews();
  const email = buildEmail(items, new Date());
  const subscribers = await listSubscribers(env.SUBSCRIBERS);

  let sent = 0;
  let failed = 0;
  for (const to of subscribers) {
    try {
      await sendOne(env, to, email);
      sent++;
    } catch {
      // Tolerate individual failures — keep sending to the rest.
      failed++;
    }
    await sleep(SEND_DELAY_MS);
  }

  return { subscribers: subscribers.length, sent, failed, items: items.length };
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
