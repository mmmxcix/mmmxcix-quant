// WebSocket relay: browser ⇄ this Function ⇄ aisstream.io.
//
// Why a relay: aisstream.io does NOT support browser connections (they reject
// them to protect API keys). So the browser connects to OUR origin and this
// Function bridges to aisstream, injecting the key from the Cloudflare secret
// AISSTREAM_KEY server-side — the key never reaches any browser, file or
// commit. Gated on the signed-in ADMIN (dev) session so public visitors can't
// stream on the owner's key.

import { isAdminRequest } from "../_lib/auth.mjs";

const UPSTREAM = "https://stream.aisstream.io/v0/stream";

// Accept the socket first, then fail with a readable error frame — a plain
// HTTP 4xx on an upgrade request surfaces as an opaque onerror in browsers.
function refuse(reason) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(JSON.stringify({ error: reason }));
  server.close(1008, reason);
  return new Response(null, { status: 101, webSocket: client });
}

export async function onRequest({ request, env }) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response(JSON.stringify({ error: "websocket only" }), { status: 426, headers: { "content-type": "application/json" } });
  }
  if (!env.AISSTREAM_KEY) return refuse("Ship tracking not configured (AISSTREAM_KEY secret missing).");
  // Browser auth: admin session cookie. Machine auth (agents, health checks):
  // ?token= matching the machine token — WS clients can't set headers.
  const url = new URL(request.url);
  const tokenOk = !!env.DEV_ACCESS_TOKEN && url.searchParams.get("token") === env.DEV_ACCESS_TOKEN;
  if (!tokenOk && !(await isAdminRequest(env, request))) return refuse("Sign in with the dev account to use ship tracking.");

  let upstream;
  try {
    const resp = await fetch(UPSTREAM, { headers: { Upgrade: "websocket" } });
    upstream = resp.webSocket;
    if (!upstream) return refuse(`aisstream unavailable (HTTP ${resp.status}) — usually temporary overload, retrying helps.`);
  } catch {
    return refuse("aisstream unreachable — retrying helps.");
  }
  upstream.accept();

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  const closeBoth = () => {
    try { server.close(); } catch { /* already closed */ }
    try { upstream.close(); } catch { /* already closed */ }
  };

  // aisstream enforces two timing rules: the FIRST subscription must arrive
  // within 3 seconds of the connect, and updates are limited to one per
  // second. The client's subscription travels browser→edge and can lose the
  // 3s race — so the relay immediately sends a world subscription itself,
  // then forwards the client's real one no earlier than 1.1s later.
  const subscribedAt = Date.now();
  upstream.send(JSON.stringify({
    APIKey: env.AISSTREAM_KEY,
    BoundingBoxes: [[[-85, -180], [85, 180]]],
    FilterMessageTypes: ["PositionReport", "ShipStaticData"],
  }));

  server.addEventListener("message", (e) => {
    try {
      const m = JSON.parse(e.data);
      m.APIKey = env.AISSTREAM_KEY; // the client never sends (or knows) the key
      const wait = Math.max(0, 1100 - (Date.now() - subscribedAt));
      setTimeout(() => { try { upstream.send(JSON.stringify(m)); } catch { /* upstream gone */ } }, wait);
    } catch { /* non-JSON frame from client — drop it */ }
  });
  // aisstream → browser: pass through untouched (PositionReports + error frames).
  upstream.addEventListener("message", (e) => {
    try { server.send(e.data); } catch { closeBoth(); }
  });
  // Surface WHY the upstream died instead of closing silently — the client
  // shows this in its status badge.
  upstream.addEventListener("close", (e) => {
    try { server.send(JSON.stringify({ error: `aisstream closed (${e.code}${e.reason ? ": " + String(e.reason).slice(0, 80) : ""}) — reconnecting` })); } catch { /* client gone */ }
    closeBoth();
  });
  upstream.addEventListener("error", () => {
    try { server.send(JSON.stringify({ error: "aisstream connection error — reconnecting" })); } catch { /* client gone */ }
    closeBoth();
  });
  server.addEventListener("close", closeBoth);
  server.addEventListener("error", closeBoth);

  return new Response(null, { status: 101, webSocket: client });
}
