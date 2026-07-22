# Auth setup (Better Auth + Cloudflare D1)

Self-hosted authentication — users, sessions, 2FA secrets and password hashes all
live in **your** Cloudflare D1. No third-party auth service.

The code is already in the repo:

- `functions/_lib/auth.mjs` — the Better Auth server config (email/password,
  optional TOTP 2FA, admin role, dev-account-by-email). `_lib` is underscore-
  prefixed so Cloudflare Pages does **not** turn it into a route.
- `functions/api/auth/[[path]].js` — mounts it at `/api/auth/*`.
- `src/lib/authClient.js`, `src/pages/Login.jsx`, `src/pages/Register.jsx` — the UI.
- `db/better-auth-schema.sql` — the D1 schema (generated from the exact plugin set).

## One-time infra steps (only you can do these — they touch your Cloudflare account)

Run from the repo root with `wrangler` logged in (`npx wrangler login`).

### 1. Create the D1 database

```bash
npx wrangler d1 create mmmxcix-quant-auth
```

Note the `database_id` it prints.

### 2. Apply the schema

```bash
# production (remote) DB:
npx wrangler d1 execute mmmxcix-quant-auth --remote --file=./db/better-auth-schema.sql
# and for local `wrangler pages dev` testing:
npx wrangler d1 execute mmmxcix-quant-auth --local  --file=./db/better-auth-schema.sql
```

### 3. Bind D1 to the Pages project — binding name **`DB`**

Cloudflare dashboard → your Pages project → **Settings → Functions → D1 database
bindings** → **Add binding**: variable name `DB`, database `mmmxcix-quant-auth`.
Add it for **both** Production and Preview.

### 4. Set the secrets / vars (same place KV / provider keys already live)

Pages project → **Settings → Environment variables**:

| Name | Type | Value |
|------|------|-------|
| `BETTER_AUTH_SECRET` | **Secret** | `openssl rand -base64 32` (a long random string) |
| `BETTER_AUTH_URL` | Variable | `https://quant.mmmxcix.com` (your production URL) |
| `DEV_EMAIL` | Variable | `admin@mmmxcix.com` — the account that becomes admin |

### 5. Deploy + create your dev account

Push to `main` (Pages rebuilds). Then go to **`/register`** and sign up with
`admin@mmmxcix.com` — that email is minted as the **admin** (dev) account, which
is what will gate every dev tool once the token gate is swapped over.

## What's next (in code, after the DB is live)

Once you've done the steps above and confirmed sign-in works, the next commit
rewires gating: the dev tools (Coach, Cortex, Brain Vault, the generate/lab APIs)
stop checking the shared `DEV_ACCESS_TOKEN` and instead require the **admin
session** — non-admins simply don't see them. Regular accounts are the base for
the later paywall.

## 2FA

Optional per user. Once accounts work we'll add a "Security" section (enable TOTP
→ scan QR → confirm code). A 2FA-enabled account is asked for its 6-digit code on
sign-in (already handled in `Login.jsx`).

## Email verification / password reset

Off for now (registration works immediately). When you want them, they can reuse
the **Resend** key already configured for the daily digest (`RESEND_API_KEY` /
`DIGEST_FROM`) — still your infra, no new third party.
