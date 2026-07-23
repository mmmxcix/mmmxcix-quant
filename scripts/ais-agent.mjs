// ais-agent.mjs — the fleet agent (runs 24/7 on the user's PC, autostarted).
//
// aisstream.io feeds residential connections generously but ignores
// Cloudflare egress, so this agent — not a server relay — holds the ONE
// aisstream websocket, merges PositionReports with ShipStaticData, and
// pushes a compact world snapshot to the site every ~45s. The map then
// paints the entire fleet instantly on load (the worldmonitor pattern)
// instead of filling a live stream from zero.
//
// Env: AISSTREAM_KEY (aisstream.io key), LAB_TOKEN (site machine token),
//      LAB_SITE (default https://quant.mmmxcix.com)

const KEY = process.env.AISSTREAM_KEY;
const TOKEN = process.env.LAB_TOKEN;
const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const PUSH_MS = 45_000;
const STALE_MS = 12 * 60_000;
const MAX_SHIPS = 30_000;

if (!KEY) { console.error("AISSTREAM_KEY is not set."); process.exit(1); }
if (!TOKEN) { console.error("LAB_TOKEN is not set."); process.exit(1); }

const vessels = new Map(); // mmsi -> { lat, lon, sog, cog, type, name, dest, t }
let msgCount = 0;
const dec = new TextDecoder();

function connect() {
  const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    console.log(`[${new Date().toISOString()}] aisstream connected — subscribing world`);
    ws.send(JSON.stringify({
      APIKey: KEY,
      BoundingBoxes: [[[-85, -180], [85, 180]]],
      FilterMessageTypes: ["PositionReport", "ShipStaticData"],
    }));
  };
  ws.onmessage = (ev) => {
    try {
      const text = typeof ev.data === "string" ? ev.data : dec.decode(ev.data);
      const m = JSON.parse(text);
      const md = m.MetaData || m.Metadata || {};
      const mmsi = md.MMSI;
      if (!mmsi) return;
      msgCount++;
      const cur = vessels.get(mmsi) || {};
      if (m.MessageType === "PositionReport") {
        const pr = m.Message?.PositionReport || {};
        const lat = md.latitude ?? pr.Latitude, lon = md.longitude ?? pr.Longitude;
        if (lat == null || lon == null) return;
        vessels.set(mmsi, {
          ...cur, lat, lon,
          sog: pr.Sog ?? 0, cog: pr.Cog ?? pr.TrueHeading ?? 0,
          name: cur.name || String(md.ShipName || "").trim(),
          t: Date.now(),
        });
      } else if (m.MessageType === "ShipStaticData") {
        const sd = m.Message?.ShipStaticData || {};
        vessels.set(mmsi, {
          ...cur,
          type: sd.Type ?? cur.type ?? null,
          name: String(sd.Name || md.ShipName || cur.name || "").trim(),
          dest: String(sd.Destination || cur.dest || "").trim(),
          t: cur.t || Date.now(),
        });
      }
    } catch { /* malformed frame */ }
  };
  ws.onclose = (e) => {
    console.log(`[${new Date().toISOString()}] aisstream closed (${e.code}) — reconnecting in 5s`);
    setTimeout(connect, 5000);
  };
  ws.onerror = () => { /* onclose follows */ };
}
connect();

async function push() {
  const now = Date.now();
  for (const [k, v] of vessels) if (now - v.t > STALE_MS) vessels.delete(k);
  const rows = [];
  for (const [mmsi, v] of vessels) {
    if (v.lat == null) continue; // static-only, no position yet
    rows.push([
      mmsi,
      +v.lat.toFixed(4), +v.lon.toFixed(4),
      +(v.sog ?? 0).toFixed(1), Math.round(v.cog ?? 0),
      v.type ?? 0, v.name || "", v.dest || "",
    ]);
  }
  rows.sort(() => 0); // stable; cap below keeps the map bounded
  const ships = rows.slice(0, MAX_SHIPS);
  try {
    const res = await fetch(`${SITE}/api/ships`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, ships }),
    });
    const out = await res.json().catch(() => ({}));
    console.log(`[${new Date().toISOString()}] pushed ${ships.length} vessels (${msgCount} msgs since last) → ${res.status} ${out.ok ? "ok" : JSON.stringify(out).slice(0, 60)}`);
  } catch (e) {
    console.error(`push failed: ${e.message}`);
  }
  msgCount = 0;
}
setInterval(push, PUSH_MS);
console.log("fleet agent running — first push in 45s");
