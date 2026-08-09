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
// (ships now ride the combined world push every 3 min — see WORLD_EVERY_MS)
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

// Snapshot the current fleet as compact rows (does NOT write — the combined
// world push does that so ships/planes/jamming cost ONE KV write per cycle).
function buildShipRows() {
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
  return rows.slice(0, MAX_SHIPS);
}

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
let lastPlanes = [];   // latest sweep result — written by the combined world push
let lastJamming = [];

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

async function pushJson(path, payload, label) {
  const res = await fetch(`${SITE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, ...payload }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(`${label} HTTP ${res.status}`);
  return out;
}

async function sweepPlanes() {
  if (planeSweepRunning) return;
  planeSweepRunning = true;
  try {
    const byHex = new Map();
    const jam = new Map(); // "latCell,lonCell" -> { total, bad }
    for (const [lat, lon] of PLANE_TILES) {
      const ac = await fetchTile(lat, lon);
      for (const a of ac) {
        if (a.lat == null || a.lon == null || !a.hex) continue;
        const onGround = a.alt_baro === "ground";
        byHex.set(a.hex, [
          a.hex, +(+a.lat).toFixed(3), +(+a.lon).toFixed(3),
          onGround ? -1 : Math.round(+a.alt_baro || 0),
          Math.round(+a.gs || 0), Math.round(+(a.track ?? a.true_heading) || 0),
          a.category || "", String(a.flight || "").trim(), a.t || "",
        ]);
        // GPS-jamming signal: an AIRBORNE aircraft with a valid lat/lon but a
        // degraded navigation-integrity category (NIC 0 or low NACp) is the
        // classic ADS-B jamming footprint (gpsjam.org's exact method).
        if (!onGround && a.nic != null && a.nac_p != null) {
          const key = `${Math.floor(+a.lat)},${Math.floor(+a.lon)}`;
          const cell = jam.get(key) || { total: 0, bad: 0 };
          cell.total++;
          if (+a.nic === 0 || +a.nac_p <= 4) cell.bad++;
          jam.set(key, cell);
        }
      }
      await new Promise((r) => setTimeout(r, 400)); // fair-use pacing
    }
    lastPlanes = [...byHex.values()];
    // Report only cells with enough aircraft AND a meaningful bad share.
    const jamming = [];
    for (const [key, c] of jam) {
      if (c.total < 5) continue;
      const frac = c.bad / c.total;
      if (frac < 0.25) continue;
      const [la, lo] = key.split(",").map(Number);
      jamming.push([la + 0.5, lo + 0.5, +frac.toFixed(2), c.total]);
    }
    lastJamming = jamming;
    console.log(`[${new Date().toISOString()}] plane sweep: ${lastPlanes.length} aircraft, ${jamming.length} jamming cells (cached for world push)`);
  } catch (e) {
    console.error(`plane sweep failed: ${e.message}`);
  } finally {
    planeSweepRunning = false;
  }
}
setInterval(sweepPlanes, PLANES_EVERY_MS);
sweepPlanes();

// ── Combined WORLD push (ships + planes + jamming in ONE KV write) ──────────
// Free-plan KV allows 1000 writes/day. Three separate keys every 45–90s blew
// past that; one combined key every 3 min is ~480 writes/day and keeps the map
// effectively live. Gathering stays continuous (aisstream buffer + 90s plane
// sweep); only the WRITE is throttled and bundled.
const WORLD_EVERY_MS = 3 * 60_000;
async function pushWorld() {
  const ships = buildShipRows();
  try {
    const out = await pushJson("/api/world", { ships, planes: lastPlanes, jamming: lastJamming }, "world");
    console.log(`[${new Date().toISOString()}] world: pushed ${out.ships} ships · ${out.planes} planes · ${out.jamming} jamming (${msgCount} AIS msgs) → ok`);
  } catch (e) {
    console.error(`world push failed: ${e.message}`);
  }
  msgCount = 0;
}
setInterval(pushWorld, WORLD_EVERY_MS);
setTimeout(pushWorld, 20_000); // first push once the aisstream buffer has filled

// ── NASA FIRMS fire sweep (24h global VIIRS, every 30 min) ──────────────────
// The MAP_KEY lives only in the PC's env (never in files/commits/client).
// FIRMS itself refreshes ~every 3h, so 30 min polling is already generous.
const FIRMS_KEY = process.env.FIRMS_MAP_KEY;
const FIRES_EVERY_MS = 60 * 60_000; // FIRMS refreshes ~3h; hourly is plenty and saves KV writes
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

// ── UCDP conflict sweep (monthly candidate CSVs, every 12h) ─────────────────
// Uppsala Conflict Data Program: free direct downloads, no key. "Candidate"
// files are the preliminary monthly coding (revised in the annual release) —
// the only free source with this recency at academic quality.
const CONFLICTS_EVERY_MS = 12 * 3600_000;
let lastConflicts = null;
let conflictsPushTries = 0;

// Minimal quote-aware CSV parser (UCDP fields embed commas, quotes, newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function pushConflicts() {
  if (!lastConflicts) return;
  try {
    const res = await fetch(`${SITE}/api/conflicts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, conflicts: lastConflicts }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(`HTTP ${res.status}`);
    conflictsPushTries = 0;
    console.log(`[${new Date().toISOString()}] conflicts: pushed ${lastConflicts.length} events → ok`);
  } catch (e) {
    const again = conflictsPushTries++ < 3;
    console.error(`conflicts push failed (${e.message}) — ${again ? "retrying in 2min" : "waiting for next sweep"}`);
    if (again) setTimeout(pushConflicts, 120_000);
  }
}

async function sweepConflicts() {
  try {
    const now = new Date();
    const events = [];
    let months = 0;
    // Probe backwards from the current month; keep the last 6 that exist.
    for (let k = 0; k < 10 && months < 6; k++) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      const url = `https://ucdp.uu.se/downloads/candidateged/GEDEvent_v${String(d.getFullYear()).slice(2)}_0_${d.getMonth() + 1}.csv`;
      let r;
      try { r = await fetch(url, { signal: AbortSignal.timeout(120_000) }); } catch { continue; }
      if (!r.ok) continue;
      months++;
      const rows = parseCsv(await r.text());
      const head = rows[0];
      const col = (n) => head.indexOf(n);
      const iTov = col("type_of_violence"), iA = col("side_a"), iB = col("side_b"),
        iLat = col("latitude"), iLon = col("longitude"), iC = col("country"),
        iD = col("date_start"), iBest = col("best");
      if (iLat < 0 || iLon < 0) continue;
      for (let i = 1; i < rows.length; i++) {
        const p = rows[i];
        const lat = +p[iLat], lon = +p[iLon];
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) continue;
        events.push([
          +lat.toFixed(2), +lon.toFixed(2), Math.max(0, Math.round(+p[iBest] || 0)), +p[iTov] || 0,
          String(p[iD] || "").slice(0, 10), String(p[iC] || "").slice(0, 30),
          String(p[iA] || "").slice(0, 40), String(p[iB] || "").slice(0, 40),
        ]);
      }
    }
    if (!events.length) throw new Error("no candidate files reachable");
    events.sort((a, b) => b[4].localeCompare(a[4])); // newest first
    lastConflicts = events.slice(0, 9000);
    conflictsPushTries = 0;
    console.log(`[${new Date().toISOString()}] conflicts: ${events.length} events from ${months} UCDP months → ${lastConflicts.length} kept`);
    await pushConflicts();
  } catch (e) {
    console.error(`UCDP sweep failed: ${e.message}`);
  }
}
setInterval(sweepConflicts, CONFLICTS_EVERY_MS);
setTimeout(sweepConflicts, 30_000);

// ── GDACS natural hazards (floods/droughts/cyclones/wildfires), every 30 min ─
const DISASTERS_EVERY_MS = 60 * 60_000; // GDACS updates slowly; hourly saves KV writes
const GDACS_TYPES = { FL: "FL", DR: "DR", TC: "TC", WF: "WF" }; // drop EQ (USGS covers quakes)
const ALERT = { Green: 0, Orange: 1, Red: 2 };

// GDACS returns MANY features per event — a Point (current position), a LineString
// (cyclone track) and several Polygons (forecast cones / affected areas), all sharing
// one eventid. The old parser read c[1] as a latitude on ALL of them, so a Polygon's
// nested coordinate became NaN (→ null) and every geometry-part duplicated the event
// (e.g. one cyclone appeared 118×). Extract ONE representative [lon,lat] per geometry
// and keep ONE marker per eventid, preferring the Point (the real current position).
function gdacsPoint(g) {
  if (!g || !Array.isArray(g.coordinates)) return null;
  const c = g.coordinates;
  const ok = (x, y) => (Number.isFinite(+x) && Number.isFinite(+y) ? [+x, +y] : null);
  if (g.type === "Point") return ok(c[0], c[1]);
  if (g.type === "LineString" && c.length) { const m = c[Math.floor(c.length / 2)]; return Array.isArray(m) ? ok(m[0], m[1]) : null; }
  if (g.type === "Polygon" && Array.isArray(c[0]) && c[0].length) { // centroid of the outer ring
    let sx = 0, sy = 0, n = 0;
    for (const pt of c[0]) if (Array.isArray(pt) && Number.isFinite(+pt[0]) && Number.isFinite(+pt[1])) { sx += +pt[0]; sy += +pt[1]; n++; }
    return n ? [sx / n, sy / n] : null;
  }
  return null;
}
async function sweepDisasters() {
  try {
    const r = await fetch("https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP", { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`GDACS HTTP ${r.status}`);
    const j = await r.json();
    const byEvent = new Map(); // eventid -> best feature {p, pt, isPoint}
    for (const f of j.features || []) {
      const p = f.properties || {};
      if (!GDACS_TYPES[p.eventtype]) continue;
      const pt = gdacsPoint(f.geometry);
      if (!pt) continue;
      const id = p.eventid ?? `${p.eventtype}:${p.name}`;
      const isPoint = f.geometry?.type === "Point";
      const cur = byEvent.get(id);
      // Keep one per event: a Point (current position) beats a track/area centroid.
      if (!cur || (isPoint && !cur.isPoint)) byEvent.set(id, { p, pt, isPoint });
    }
    const out = [];
    for (const { p, pt } of byEvent.values()) {
      const sd = p.severitydata || {};
      out.push([
        +(+pt[1]).toFixed(2), +(+pt[0]).toFixed(2), p.eventtype, ALERT[p.alertlevel] ?? 0,
        String(p.name || p.eventname || "").slice(0, 60), String(p.country || "").slice(0, 40),
        String(p.fromdate || "").slice(0, 10), String(sd.severitytext || "").slice(0, 40),
      ]);
    }
    // Red first, then orange — most severe stays if we ever cap.
    out.sort((a, b) => b[3] - a[3]);
    await pushJson("/api/disasters", { disasters: out }, "disasters");
    console.log(`[${new Date().toISOString()}] disasters: pushed ${out.length} GDACS events (deduped from ${(j.features || []).length} features) → ok`);
  } catch (e) { console.error(`GDACS sweep failed: ${e.message}`); }
}
setInterval(sweepDisasters, DISASTERS_EVERY_MS);
setTimeout(sweepDisasters, 20_000);

// ── World Bank active projects ("Bauprojekte"), aggregated per country, 12h ──
const PROJECTS_EVERY_MS = 12 * 3600_000;
async function sweepProjects() {
  try {
    const url = "https://search.worldbank.org/api/v2/projects?format=json&rows=1000&fl=project_name,countryshortname,totalcommamt&status_exact=Active";
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`WB HTTP ${r.status}`);
    const j = await r.json();
    const byCountry = new Map();
    for (const p of Object.values(j.projects || {})) {
      const country = String(p.countryshortname || "").trim();
      if (!country || country.length > 40 || /World|Africa|OECS|Eastern|Western|Pacific/.test(country) && country.includes(",")) continue;
      const usd = +String(p.totalcommamt || "0").replace(/[^0-9.]/g, "") || 0;
      const c = byCountry.get(country) || { count: 0, usd: 0, names: [] };
      c.count++; c.usd += usd;
      if (c.names.length < 6 && p.project_name) c.names.push(String(p.project_name).slice(0, 70));
      byCountry.set(country, c);
    }
    const out = [...byCountry.entries()].map(([country, c]) => [country, c.count, Math.round(c.usd), c.names]);
    out.sort((a, b) => b[2] - a[2]);
    await pushJson("/api/projects", { projects: out }, "projects");
    console.log(`[${new Date().toISOString()}] projects: pushed ${out.length} countries → ok`);
  } catch (e) { console.error(`WB sweep failed: ${e.message}`); }
}
setInterval(sweepProjects, PROJECTS_EVERY_MS);
setTimeout(sweepProjects, 40_000);

// ── Satellite TLEs (curated CelesTrak groups), every 8h ─────────────────────
// Group -> how many to keep (Starlink is 10k+; a sample is plenty visually).
const SAT_GROUPS = {
  stations: 999, "gps-ops": 999, galileo: 999, "glo-ops": 999, beidou: 999,
  weather: 999, science: 999, "geo": 200, starlink: 300,
};
const SATS_EVERY_MS = 8 * 3600_000;
async function sweepSatellites() {
  try {
    const rows = [];
    for (const [group, keep] of Object.entries(SAT_GROUPS)) {
      let text;
      try {
        const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`, { signal: AbortSignal.timeout(30_000) });
        if (!r.ok) continue;
        text = await r.text();
      } catch { continue; }
      const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
      const set = [];
      for (let i = 0; i + 2 < lines.length; i += 3) {
        const name = lines[i].trim(), l1 = lines[i + 1], l2 = lines[i + 2];
        if (!l1.startsWith("1 ") || !l2.startsWith("2 ")) continue;
        set.push([name.slice(0, 30), group, l1, l2]);
      }
      const step = set.length > keep ? Math.ceil(set.length / keep) : 1;
      for (let i = 0; i < set.length; i += step) rows.push(set[i]);
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!rows.length) throw new Error("no TLEs fetched");
    await pushJson("/api/satellites", { satellites: rows }, "satellites");
    console.log(`[${new Date().toISOString()}] satellites: pushed ${rows.length} TLEs → ok`);
  } catch (e) { console.error(`satellites sweep failed: ${e.message}`); }
}
setInterval(sweepSatellites, SATS_EVERY_MS);
setTimeout(sweepSatellites, 50_000);

console.log("fleet agent running — world push (ships+planes+jamming) every 3min · fires/disasters hourly · conflicts/projects 12h · satellites 8h · ~535 KV writes/day");
