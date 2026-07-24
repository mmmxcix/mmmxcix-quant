# Production hardening — status & launch runbook

Living checklist for taking quant.mmmxcix.com public. Grouped by who has to act.

## ✅ Done (in code)

- **Security headers** (`public/_headers`): HSTS, `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and a scoped CSP
  (`frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`).
- **Secrets never in the repo**: all keys (Anthropic/Resend/LSE/AIS/FIRMS,
  `DEV_ACCESS_TOKEN`) live as Cloudflare secrets or OS env vars only.
- **Write endpoints are token-gated**: `/api/world`, `/api/ships`, `/api/planes`,
  `/api/fires`, `/api/conflicts`, `/api/disasters`, `/api/projects`,
  `/api/jamming`, `/api/satellites` all `safeEqual` against `DEV_ACCESS_TOKEN`.
- **`/api/generate` is gated** (LLM cost): needs the machine token *or* a
  signed-in admin — unauthenticated calls get 401 before any Anthropic request.
- **Rate limiting** on `/api/subscribe` POST (5/min per IP, in-memory, zero KV
  cost) — blocks confirmation-email spam. `functions/_lib/ratelimit.mjs`.
- **KV under the free budget**: the fleet agent bundles ships+planes+jamming
  into one `/api/world` write every 3 min (~535 writes/day, well under 1000).
- **Read endpoints** are edge-cached GETs — cheap and safe to expose.
- **Tests**: `npm test` (Node built-in runner) covers the quant libs (HRP,
  GARCH, pairs/cointegration, Benjamini-Hochberg FDR). `npm run check` runs
  tests + the 25-route render smoke. **Run `npm run check` before every push.**

## ⚠️ Needs you (dashboard, ~5 min) — required for launch

1. **Resend on the Pages project** — the confirmation email doesn't send because
   `/api/subscribe` has no Resend creds. Cloudflare → Pages project → Settings →
   Environment variables (Production) → add `RESEND_API_KEY` and `DIGEST_FROM`
   (same values as the `quant-digest` worker). *Root cause of "no confirmation
   email".*
2. **Verify the sender domain in Resend** (Domains tab) — if the `DIGEST_FROM`
   domain isn't verified, no mail sends at all (not the digest either).
3. **Cloudflare WAF rate-limiting rule** — add an edge rule (free tier includes
   one) on `/api/*` for real DDoS protection; the in-code limiter is only
   best-effort per-isolate.

## 🔜 Before a wide public launch (bigger work)

- **CSP `'unsafe-eval'`**: currently required because the backtest compiles
  strategy code with `new Function()` + Pyodide WASM. Move that eval into a
  sandboxed Worker so the main-app CSP can drop `unsafe-eval`.
- **Email verify + password reset**: wire the D1 (Better Auth) flow to Resend
  once the auth rework lands. Depends on the auth/D1 work in progress.
- **Error monitoring**: add structured error logging / an alerting hook so
  silent failures (like the empty-digest bug) surface fast.
