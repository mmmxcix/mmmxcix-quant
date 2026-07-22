// authClient.js — the browser side of Better Auth. Talks to /api/auth on the
// same origin (session is an HttpOnly cookie, so nothing sensitive touches JS).
// useSession() is a live hook; adminClient adds role checks, twoFactorClient the
// optional TOTP flow.
import { createAuthClient } from "better-auth/react";
import { twoFactorClient, adminClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // baseURL defaults to the current origin; basePath defaults to /api/auth,
  // matching the server mount — no config needed for the SPA.
  plugins: [twoFactorClient(), adminClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;

/** True when the signed-in user is the privileged dev/admin account. */
export function isAdmin(session) {
  return session?.user?.role === "admin";
}
