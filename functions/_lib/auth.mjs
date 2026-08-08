// auth.mjs — self-hosted authentication with Better Auth, running entirely on
// YOUR Cloudflare infra. No third-party auth service:
//   • users / sessions / 2FA secrets / backup codes  → Cloudflare D1 (env.DB)
//   • passwords are hashed by Better Auth (scrypt); plaintext is never stored
//   • sessions are HttpOnly cookies, validated server-side and revocable
//
// Mounted by functions/api/auth/[[path]].js at /api/auth/*. The frontend talks
// to it via src/lib/authClient.js. Requires these Cloudflare bindings/secrets
// (see docs/AUTH_SETUP.md):
//   D1 binding            DB
//   Secret                BETTER_AUTH_SECRET   (openssl rand -base64 32)
//   Var (optional)        BETTER_AUTH_URL      (e.g. https://quant.mmmxcix.com)
//   Var (optional)        DEV_EMAIL            (the one admin account; default admin@mmmxcix.com)

import { betterAuth } from "better-auth";
import { twoFactor, admin } from "better-auth/plugins";
import { D1Dialect } from "kysely-d1";

/**
 * Build the Better Auth instance. Kept as a factory so the runtime handler (real
 * env.DB) and the schema-generation CLI (a placeholder db) share one config.
 * @param {object} opts { db, secret, baseURL, devEmail }
 */
export function buildAuth({ db, secret, baseURL, devEmail }) {
  return betterAuth({
    appName: "MMMXCIX Quant",
    database: { dialect: new D1Dialect({ database: db }), type: "sqlite" },
    secret,
    baseURL,
    // The Pages preview domain is a legitimate second entrance to the SAME
    // deployment — when the custom domain has a problem (a poisoned CDN/browser
    // cache, a DNS change), *.pages.dev is how you still get in. Without it
    // Better Auth rejects the sign-in as a foreign origin.
    trustedOrigins: [
      baseURL,
      "https://mmmxcix-quant.pages.dev",
      "https://quant.mmmxcix.com",
    ].filter(Boolean),
    basePath: "/api/auth",
    emailAndPassword: {
      enabled: true,
      // Open registration. No external mail is wired yet, so we don't gate
      // sign-in on email verification (can be turned on later via Resend).
      requireEmailVerification: false,
      minPasswordLength: 8,
    },
    user: {
      additionalFields: {
        // Per-account theme preference ("light" | "dark" | "system") — synced
        // across devices; the client mirrors it to localStorage for the
        // before-paint script. Set via authClient.updateUser({ theme }).
        theme: { type: "string", required: false, input: true },
      },
    },
    // SECURITY (CWE-287): the admin role must NEVER be derived from a client-claimed
    // sign-up email. Deriving it from DEV_EMAIL let anyone mint an admin session simply
    // by registering that address (open registration + no email verification) — Strix
    // rated it CVSS 9.4. Everyone now signs up as "user"; the single admin account is
    // provisioned out-of-band (it already exists — to (re)grant admin, promote that user
    // row directly / via the admin plugin, never through sign-up).
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({ data: { ...user, role: "user" } }),
        },
      },
    },
    plugins: [twoFactor(), admin()],
  });
}

/** Runtime entry: build from the Pages Function `env` bindings. */
export function authFromEnv(env) {
  return buildAuth({
    db: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || "https://quant.mmmxcix.com",
    devEmail: env.DEV_EMAIL,
  });
}

/**
 * The signed-in user for this request (HttpOnly session cookie), or null.
 * Never throws — auth not being configured just reads as "not signed in".
 */
export async function sessionUser(env, request) {
  if (!env.DB || !env.BETTER_AUTH_SECRET) return null;
  try {
    const s = await authFromEnv(env).api.getSession({ headers: request.headers });
    return s?.user || null;
  } catch {
    return null;
  }
}

/**
 * True when the request carries a signed-in ADMIN session (the dev account).
 * This is what gates every dev tool for humans; agents authenticate with their
 * machine token instead (see generate.js / lab.js).
 */
export async function isAdminRequest(env, request) {
  const u = await sessionUser(env, request);
  return !!u && u.role === "admin";
}
