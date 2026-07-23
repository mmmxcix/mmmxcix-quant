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

// ── global AIR-TRAFFIC sweep (same agent, same pattern) ─────────────────────
// Cloudflare egress gets rate-limited by the community ADS-B APIs; a home IP
// with gentle pacing doesn't. ~26 dense flight regions, 250 nm each, one
// sweep per ~90s at ≤2.5 req/s — merged by hex and pushed as one snapshot.
const PLANE_TILES = [
  // Europe
  [50, 0], [50, 15], [45, 25], [60, 15], [40, -5], [52, -8],
  // North America
  [40, -75], [34, -85], [42, -90], [33, -100], [37, -120], [48, -122], [26, -80],
  // Asia
  [35, 138], [31, 121], [23, 113], [37, 127], [13, 100], [28, 77], [1, 103],
  // Middle East · LatAm · Oceania · Africa
  [25, 55], [30, 35], [-23, -46], [19, -99], [-34, 151], [-26, 28],
];
const PLANES_EVERY_MS = 90_000;
let planeSweepRunning = false;

async function fetchTile(lat, lon) {
  for (const base of ["https://api.adsb.lol", "https://api.airplanes.live"]) {
    try {
      const r = await fetch(`${base}/v2/point/${lat}/${lon}/250`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j?.ac)) return j.ac;
    } catch { /* next provider */ }
  }
  return [];
}

async function sweepPlanes() {
  if (planeSweepRunning) return;
  planeSweepRunning = true;
  try {
    const byHex = new Map();
    for (const [lat, lon] of PLANE_TILES) {
      const ac = await fetchTile(lat, lon);
      for (const a of ac) {
        if (a.lat == null || a.lon == null || !a.hex) continue;
        byHex.set(a.hex, [
          a.hex, +(+a.lat).toFixed(3), +(+a.lon).toFixed(3),
          a.alt_baro === "ground" ? -1 : Math.round(+a.alt_baro || 0),
          Math.round(+a.gs || 0), Math.round(+(a.track ?? a.true_heading) || 0),
          a.category || "", String(a.flight || "").trim(), a.t || "",
        ]);
      }
      await new Promise((r) => setTimeout(r, 400)); // fair-use pacing
    }
    const planes = [...byHex.values()];
    const res = await fetch(`${SITE}/api/planes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, planes }),
    });
    const out = await res.json().catch(() => ({}));
    console.log(`[${new Date().toISOString()}] planes: pushed ${planes.length} aircraft → ${res.status} ${out.ok ? "ok" : JSON.stringify(out).slice(0, 50)}`);
  } catch (e) {
    console.error(`plane sweep failed: ${e.message}`);
  } finally {
    planeSweepRunning = false;
  }
}
setInterval(sweepPlanes, PLANES_EVERY_MS);
sweepPlanes();

// ── NASA FIRMS fire sweep (24h global VIIRS, every 30 min) ──────────────────
// The MAP_KEY lives only in the PC's env (never in files/commits/client).
// FIRMS itself refreshes ~every 3h, so 30 min polling is already generous.
const FIRMS_KEY = process.env.FIRMS_MAP_KEY;
const FIRES_EVERY_MS = 30 * 60_000;
let lastFires = null;
let firesPushTries = 0;

async function pushFires() {
  if (!lastFires) return;
  try {
    const res = await fetch(`${SITE}/api/fires`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, fires: lastFires }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(`HTTP ${res.status}`);
    firesPushTries = 0;
    console.log(`[${new Date().toISOString()}] fires: pushed ${lastFires.length} detections → ok`);
  } catch (e) {
    // Re-POST only (no FIRMS re-fetch) — covers boot races and deploys.
    const again = firesPushTries++ < 3;
    console.error(`fires push failed (${e.message}) — ${again ? "retrying in 2min" : "waiting for next sweep"}`);
    if (again) setTimeout(pushFires, 120_000);
  }
}

async function sweepFires() {
  try {
    const r = await fetch(
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_KEY}/VIIRS_SNPP_NRT/world/1`,
      { signal: AbortSignal.timeout(180_000) },
    );
    if (!r.ok) throw new Error(`FIRMS HTTP ${r.status}`);
    const lines = (await r.text()).trim().split("\n");
    const head = lines[0].split(",");
    const iLat = head.indexOf("latitude"), iLon = head.indexOf("longitude"), iFrp = head.indexOf("frp");
    if (iLat < 0 || iLon < 0) throw new Error("unexpected CSV header");
    const byCell = new Map(); // 0.01°-rounded cell -> strongest detection
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(",");
      const lat = +p[iLat], lon = +p[iLon], frp = +(p[iFrp] || 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
      const cur = byCell.get(key);
      if (!cur || frp > cur[2]) byCell.set(key, [+lat.toFixed(2), +lon.toFixed(2), +frp.toFixed(1)]);
    }
    lastFires = [...byCell.values()].sort((a, b) => b[2] - a[2]).slice(0, 12000);
    firesPushTries = 0;
    console.log(`[${new Date().toISOString()}] fires: FIRMS sent ${lines.length - 1} detections → ${lastFires.length} after dedupe/cap`);
    await pushFires();
  } catch (e) {
    console.error(`FIRMS sweep failed: ${e.message}`);
  }
}
if (FIRMS_KEY) {
  setInterval(sweepFires, FIRES_EVERY_MS);
  setTimeout(sweepFires, 15_000);
} else {
  console.log("FIRMS_MAP_KEY not set — fire sweep disabled");
}

console.log("fleet agent running — ships in 45s, planes now, fires in 15s");
