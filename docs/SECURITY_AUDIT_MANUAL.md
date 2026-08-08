# Manual Security Audit — mmmxcix-quant (pre-Strix)

**Date:** 2026-08-08 · **Scope:** `functions/**` (all 28 API routes + `_lib`), auth,
secrets handling, injection, SSRF, authz/IDOR, cost-abuse. **Method:** manual source
review. A dynamic Strix run will follow and should be cross-checked against this.

**Reviewed in depth:** `_lib/auth.mjs`, `_lib/ratelimit.mjs`, `_lib/snapshot.js`,
`api/generate.js`, `api/subscribe.js`, `api/bias.js`, `api/news.js`, `api/library.js`,
`api/prefs.js`, `api/lab.js`, `api/telegram.js`, `api/ais-stream.js`,
`api/yahoo/[[path]].js`, `api/lse/[[path]].js`, `api/projects.js`.
**Consistency-checked (same gated pattern):** the other snapshot fleet routes
(`ships/planes/fires/conflicts/disasters/jamming/satellites/world`), `backtest-jobs.js`,
`mlmemory.js`, `conflicts.js`.

## What's already solid ✅
- **D1 is fully parameterized** (`.bind()`), no string-built SQL → no SQL injection.
- **Proxies can't be turned into an open SSRF**: `yahoo` and `lse` hard-code the
  upstream host and validate the path against a prefix allowlist; `..` cannot cross
  the host in URL normalization. `lse` key stays server-side (cache key excludes it).
- **Agent/dev routes are gated** with a constant-time token compare **and/or** the
  Better-Auth admin session: `generate`, `library`, `prefs`, `lab`, `ais-stream`,
  `argus` (writes), `telegram` (POST), and all `snapshot` writes.
- **Newsletter** uses double-opt-in with a token, size caps, input allowlists.
- **Provider error bodies are never forwarded** to clients in `generate.js`.

## Findings (severity-ranked)

### H1 — `/api/bias` is an unauthenticated, un-rate-limited LLM endpoint (wallet/quota drain)
`GET /api/bias?symbol=…&market=…&price=…` is public by design and calls the LLM
provider chain (Anthropic **first** if `ANTHROPIC_API_KEY` is set — paid). The cache
key is `biasv4:<market>:<symbol>:<price-order-of-magnitude>`, so an attacker varies
`symbol` (up to 16 chars) and `price` to bust the cache and force **unlimited fresh
LLM calls**. No rate limit. Impact: real spend on a paid key, or exhaustion of the
free Groq/Gemini quotas (feature DoS). Trivially exploitable, no preconditions.
**Fix:** rate-limit per IP (`ratelimit.mjs`); for unauthenticated calls use only the
FREE provider chain (skip Anthropic) and/or restrict `symbol` to a known universe;
optionally require a signed-in session for a fresh (uncached) read.

### H2 — Admin-account takeover window (open registration + no email verification)
`_lib/auth.mjs`: registration is open (`emailAndPassword.enabled`,
`requireEmailVerification: false`) and the **admin role is auto-granted to whoever
registers `DEV_EMAIL` (admin@mmmxcix.com)**. If that account is not already claimed,
an attacker can register it first and become admin — which gates every dev tool.
Even once claimed, the design is fragile (no verification = "first to register wins").
**Fix (now):** confirm `admin@mmmxcix.com` is already registered (it likely is). **Fix
(pre-launch):** turn on email verification for at least the admin email (Resend is
already wired), and/or seed the admin account out-of-band rather than by "first
sign-up with this email".

### M3 — `DELETE /api/subscribe?email=` has no token check
The GET/POST unsubscribe paths verify `confirmToken`; the **DELETE** method deletes
any subscriber record by email with **no auth and no rate limit** → anyone can wipe
others' subscriptions and enumerate who is subscribed (via response differences).
**Fix:** require the `confirmToken` on DELETE (same check as unsub), or remove DELETE.

### M4 — Public open registration before launch
Independent of H2: anyone can create (unverified) `user` accounts today. Non-admins
can't reach dev tools (all gated), so functional blast radius is small, but it invites
signup spam and grows the users table. **Fix:** before public launch, require email
verification and/or a light anti-abuse gate on sign-up.

### L5 — DB error details leaked to the client
`library.js`, `prefs.js`, `argus.js`, `telegram.js` return
`{ error, detail: String(e?.message||e) }` on DB failures. Behind auth, but it leaks
internal/D1 messages. **Fix:** log server-side, return a generic error to the client.

### L6 — `ais-stream` token compared with `===` (non-constant-time) and passed in the URL
`url.searchParams.get("token") === env.DEV_ACCESS_TOKEN` is a non-constant-time
compare (every other route uses `safeEqual`), and a token in the query string can land
in logs/history. WS can't set headers, so the query param is a necessary tradeoff, but
the compare should be constant-time. **Fix:** use `safeEqual`.

### L7 — `bias.js` derives `origin` from the request (Host header)
`const origin = url.origin;` is then used for internal `fetch(`${origin}/api/…`)`. A
spoofed Host could redirect those internal calls / poison the cache key. Low impact
(it only appends known Yahoo/news paths). **Fix:** pin the canonical origin.

### I8 — `DEV_ACCESS_TOKEN` is one shared secret across the whole fleet (SPOF)
The same token gates argus/lab/snapshot/generate/library/prefs/telegram/ais-stream and
lives in the shell env, the autostart `.vbs`, n8n, and several scripts. If it leaks,
an attacker gets full agent-write + dev-tool access. **Fix:** rotate periodically;
consider per-service tokens; never put it in URLs/logs.

### I9 — App-layer rate limiter is per-isolate (best-effort only)
`ratelimit.mjs` state is per-isolate and resets on eviction — fine as a speed bump, not
real protection. **Fix:** add **Cloudflare WAF rate-limiting rules** (dashboard) for
`/api/bias`, `/api/generate`, `/api/subscribe`, `/api/auth/*` — they run at the edge
before the function.

## Suggested fix order
1. **H1** rate-limit + free-only providers on `/api/bias` (code, quick).
2. **M3** token-check the `DELETE /api/subscribe` path (code, quick).
3. **H2/M4** verify admin account claimed + turn on email verification pre-launch.
4. **I9** add WAF rate-limit rules (dashboard).
5. **L5/L6/L7** hardening pass (code, quick).
6. Then run **Strix** dynamically and reconcile its findings against this list.
