// ratelimit.mjs — a zero-cost, best-effort rate limiter for Pages Functions.
//
// State lives in module scope, so it's per-isolate (not globally consistent)
// and resets when Cloudflare evicts the isolate. That's deliberate: a KV-backed
// limiter would burn the free plan's 1000 writes/day. This stops trivial
// hammering (e.g. someone POSTing /api/subscribe in a loop to spam confirmation
// emails) at no cost. For real DDoS protection, add a Cloudflare WAF
// rate-limiting rule in the dashboard — that runs at the edge before this code.

const buckets = new Map(); // key -> { count, resetAt }

/**
 * Fixed-window limiter.
 * @returns {{ok, retryAfter, remaining}} ok=false once the window is exceeded.
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 5000) { // opportunistic cleanup of expired buckets
    for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
  }
  return { ok: b.count <= limit, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)), remaining: Math.max(0, limit - b.count) };
}

/** Best-effort client IP from Cloudflare headers. */
export function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
