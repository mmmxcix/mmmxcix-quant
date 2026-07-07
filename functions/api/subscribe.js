// Cloudflare Pages Function: newsletter subscribe/unsubscribe with prefs.
// Storage: KV binding `SUBSCRIBERS`.
//   Key `sub:<email>` → JSON {
//     email, createdAt, confirmed, confirmToken,
//     prefs: { categories: ["general"|"watchlist"|"portfolio"], sources: [...] | null,
//              freeOnly: bool, symbols: [{market,symbol,name}] }
//   }
// Double opt-in: POST creates an UNCONFIRMED record + confirmToken. The record
// is only mailed by the digest worker once `confirmed` is true. Confirmation
// happens via GET ?email=&token= (the worker emails that link). This keeps the
// list GDPR/UWG-compliant (proof of consent, no mailing without opt-in).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const VALID_CATEGORIES = new Set(['general', 'watchlist', 'portfolio']);
const VALID_SOURCES = new Set(['CNBC', 'Yahoo Finance', 'CoinDesk', 'MarketWatch', 'Investing.com', 'Cointelegraph']);
const MAX_SYMBOLS = 100;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, DELETE, GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS_HEADERS },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

// Sanitize the client-supplied preferences into a safe, bounded shape.
function cleanPrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  let categories = Array.isArray(p.categories)
    ? p.categories.filter((c) => VALID_CATEGORIES.has(c))
    : [];
  if (categories.length === 0) categories = ['general'];
  const sources = Array.isArray(p.sources)
    ? [...new Set(p.sources.filter((s) => VALID_SOURCES.has(s)))]
    : null; // null = all sources
  const freeOnly = p.freeOnly !== false; // default true (safe: only free sources)
  const symbols = Array.isArray(p.symbols)
    ? p.symbols
        .filter((s) => s && typeof s.symbol === 'string' && typeof s.market === 'string')
        .slice(0, MAX_SYMBOLS)
        .map((s) => ({
          market: String(s.market).slice(0, 12),
          symbol: String(s.symbol).slice(0, 24).toUpperCase(),
          name: typeof s.name === 'string' ? s.name.slice(0, 80) : '',
        }))
    : [];
  return { categories, sources, freeOnly, symbols };
}

function randomToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Send the double-opt-in confirmation email immediately if Resend is
// configured on the Pages project (RESEND_API_KEY + DIGEST_FROM env vars).
// Returns true if sent. Falls back silently — the digest worker re-sends
// confirmation mails to still-unconfirmed records on its next run.
async function sendConfirmation(env, email, token) {
  if (!env.RESEND_API_KEY || !env.DIGEST_FROM) return false;
  const link = `https://quant.mmmxcix.com/api/subscribe?email=${encodeURIComponent(email)}&token=${token}`;
  const html =
    `<div style="background:#f4f4f7;padding:24px;font-family:system-ui,Segoe UI,sans-serif">` +
    `<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e2ea;border-radius:12px">` +
    `<tr><td style="padding:28px">` +
    `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6b6b80">MMMXCIX Quant</div>` +
    `<h1 style="margin:6px 0 12px;font-size:20px;color:#1a1a2e">Abo bestätigen</h1>` +
    `<p style="color:#3a3a4a;font-size:14px;line-height:1.6">Bitte bestätige dein Abo des Daily Digest mit einem Klick:</p>` +
    `<p style="margin:20px 0"><a href="${link}" style="background:#1a1a2e;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-size:14px">Abo bestätigen</a></p>` +
    `<p style="color:#6b6b80;font-size:12px;line-height:1.6">Falls du das nicht angefordert hast, ignoriere diese Mail — ohne Bestätigung wird nichts gesendet.</p>` +
    `</td></tr></table></div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.DIGEST_FROM,
      to: [email],
      subject: 'Bestätige dein MMMXCIX Quant Digest-Abo',
      html,
      text: `Bestätige dein Abo: ${link}\n\nOhne Bestätigung wird nichts gesendet.`,
    }),
  });
  return res.ok;
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const kv = env.SUBSCRIBERS;
  if (!kv || typeof kv.get !== 'function') {
    return method === 'GET'
      ? html('<p>Newsletter noch nicht konfiguriert.</p>', 503)
      : json({ error: 'kv_not_configured' }, 503);
  }

  try {
    // ── Confirm (double opt-in link from the worker email) ──────────────
    if (method === 'GET') {
      const url = new URL(request.url);
      const email = normalizeEmail(url.searchParams.get('email'));
      const token = url.searchParams.get('token') || '';
      if (!email) return html('<p>Ungültiger Link.</p>', 400);
      const rec = await kv.get(`sub:${email}`, 'json');
      if (!rec || rec.confirmToken !== token) return html('<p>Link ungültig oder abgelaufen.</p>', 400);
      if (!rec.confirmed) {
        rec.confirmed = true;
        rec.confirmedAt = new Date().toISOString();
        await kv.put(`sub:${email}`, JSON.stringify(rec));
      }
      return html(
        `<!doctype html><meta charset="utf-8"><title>Bestätigt</title>` +
        `<div style="font-family:system-ui;background:#0a0e14;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center">` +
        `<div><h1 style="color:#2dd4bf">✓ Abo bestätigt</h1>` +
        `<p>Du erhältst ab jetzt den MMMXCIX Quant Digest.</p>` +
        `<p><a href="https://quant.mmmxcix.com/news" style="color:#2dd4bf">Zurück zur Seite</a></p></div></div>`
      );
    }

    if (method === 'POST') {
      let payload;
      try { payload = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }

      const email = normalizeEmail(payload && payload.email);
      if (!email) return json({ error: 'invalid_email' }, 400);

      const prefs = cleanPrefs(payload && payload.prefs);
      const key = `sub:${email}`;
      const existing = await kv.get(key, 'json');

      if (existing) {
        // Update preferences on an existing record, keep confirmation state.
        existing.prefs = prefs;
        existing.updatedAt = new Date().toISOString();
        await kv.put(key, JSON.stringify(existing));
        return json({ status: existing.confirmed ? 'updated' : 'pending_confirm' });
      }

      const confirmToken = randomToken();
      let confirmSentAt = null;
      try {
        if (await sendConfirmation(env, email, confirmToken)) confirmSentAt = new Date().toISOString();
      } catch { /* worker will retry on next run */ }

      await kv.put(
        key,
        JSON.stringify({
          email,
          createdAt: new Date().toISOString(),
          confirmed: false,
          confirmToken,
          confirmSentAt,
          prefs,
        })
      );
      return json({ status: 'pending_confirm', mailed: confirmSentAt !== null });
    }

    if (method === 'DELETE') {
      const url = new URL(request.url);
      const email = normalizeEmail(url.searchParams.get('email'));
      if (!email) return json({ error: 'invalid_email' }, 400);
      await kv.delete(`sub:${email}`);
      return json({ status: 'removed' });
    }

    return json({ error: 'method_not_allowed' }, 405);
  } catch {
    return json({ error: 'internal_error' }, 500);
  }
}
