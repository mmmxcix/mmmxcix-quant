// Cloudflare Pages Function: newsletter subscribe/unsubscribe.
// Storage: KV binding `SUBSCRIBERS` (see workers/README.md for setup).
// Keys: `sub:<email>` → JSON { email, createdAt }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (method !== 'POST' && method !== 'DELETE') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const kv = env.SUBSCRIBERS;
  if (!kv || typeof kv.get !== 'function') {
    return json({ error: 'kv_not_configured' }, 503);
  }

  try {
    if (method === 'POST') {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: 'invalid_json' }, 400);
      }

      const email = normalizeEmail(payload && payload.email);
      if (!email) {
        return json({ error: 'invalid_email' }, 400);
      }

      const key = `sub:${email}`;
      const existing = await kv.get(key);
      if (existing !== null) {
        return json({ status: 'already' });
      }

      await kv.put(
        key,
        JSON.stringify({ email, createdAt: new Date().toISOString() })
      );
      return json({ status: 'ok' });
    }

    // DELETE — unsubscribe via ?email=
    const url = new URL(request.url);
    const email = normalizeEmail(url.searchParams.get('email'));
    if (!email) {
      return json({ error: 'invalid_email' }, 400);
    }

    await kv.delete(`sub:${email}`);
    return json({ status: 'removed' });
  } catch {
    // Never leak internals.
    return json({ error: 'internal_error' }, 500);
  }
}
