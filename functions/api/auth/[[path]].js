// Catch-all mount for Better Auth at /api/auth/* (sign-up, sign-in, sign-out,
// session, two-factor, admin). The whole auth surface is this one handler; the
// library routes internally by path + method.
import { authFromEnv } from "../../_lib/auth.mjs";

export const onRequest = async ({ request, env }) => {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "auth_not_configured", hint: "Bind a D1 database as DB and set BETTER_AUTH_SECRET (see docs/AUTH_SETUP.md)." }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  return authFromEnv(env).handler(request);
};
