// netRetry.js — the one place that knows how to ask a rate-limited data source
// for a whole universe without silently losing half of it.
//
// Every screen in this app that ranks or correlates a UNIVERSE hits the same
// wall: 40-odd symbols go out at once, an edge rate limit answers some of them
// with 429, and the caller's `catch { return null }` files that under the same
// heading as "this symbol has no data". The symbol vanishes, the ranking runs on
// whatever survived, and the page reports it as though the universe were whole.
// Measured on production: 29 of ~40 symbols 429'd on one load of the Anomalies
// page. A factor sort computed on a third of its universe is a different
// measurement, and nothing said so.
//
// Two things fix that, and both belong together rather than copy-pasted per
// module: back off and RETRY the statuses that are transient, and let the caller
// tell a transport failure apart from a genuine absence of data.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Statuses worth asking again: a rate limit and a server hiccup both clear. */
export const isTransient = (status) => status === 429 || status === 408 || status >= 500;

/**
 * fetch() with bounded backoff on transient statuses.
 *
 * Resolves with the Response on success. On failure it THROWS an Error carrying
 * `status` and `transient`, so a caller can record "could not reach" separately
 * from "returned nothing" instead of collapsing the two.
 *
 * Jittered, because a universe scan retries in a herd otherwise and lands the
 * whole burst on the limiter again at the same instant.
 */
export async function fetchRetry(url, { attempts = 3, baseMs = 700, ...init } = {}) {
  let res = null;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    let wait = baseMs * (i + 1) + Math.floor(Math.random() * 300);
    try {
      res = await fetch(url, init);
      if (res.ok) return res;
      if (!isTransient(res.status) || i === attempts - 1) break;
      // A rate limit is measured over a WINDOW, so retrying in under a second
      // just spends another request against the same window. Back off far
      // enough to be on the other side of it, and prefer the limiter's own
      // number when it sends one.
      if (res.status === 429) {
        const ra = Number(res.headers?.get?.("retry-after"));
        wait = Number.isFinite(ra) && ra > 0
          ? Math.min(30_000, ra * 1000)
          : 2500 * (i + 1) + Math.floor(Math.random() * 800);
      }
    } catch (e) {
      lastErr = e; // network-level failure — also worth one more try
      if (i === attempts - 1) break;
    }
    await sleep(wait);
  }
  const err = new Error(res ? `HTTP ${res.status} for ${url}` : `network error for ${url}: ${lastErr?.message || "unknown"}`);
  err.status = res ? res.status : 0;
  err.transient = res ? isTransient(res.status) : true;
  err.response = res;
  throw err;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Results keep the input
 * order. Three copies of this existed (factors, screener, quotes); they are the
 * same function and a universe scan's politeness should not depend on which
 * module happens to be driving it.
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
