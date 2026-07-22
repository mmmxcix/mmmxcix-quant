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
  const dev = (devEmail || "admin@mmmxcix.com").toLowerCase();
  return betterAuth({
    appName: "MMMXCIX Quant",
    database: { dialect: new D1Dialect({ database: db }), type: "sqlite" },
    secret,
    baseURL,
    basePath: "/api/auth",
    emailAndPassword: {
      enabled: true,
      // Open registration. No external mail is wired yet, so we don't gate
      // sign-in on email verification (can be turned on later via Resend).
      requireEmailVerification: false,
      minPasswordLength: 8,
    },
    // The single privileged "dev" account: whoever registers with DEV_EMAIL is
    // minted with role "admin". Every dev tool gates on that role once the old
    // dev-token check is swapped over — no shared secret to leak.
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: { ...user, role: user.email && user.email.toLowerCase() === dev ? "admin" : "user" },
          }),
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
