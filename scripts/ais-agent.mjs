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
    const planes = [...byHex.values()];
    const out = await pushJson("/api/planes", { planes }, "planes");
    console.log(`[${new Date().toISOString()}] planes: pushed ${planes.length} aircraft → 200 ${out.ok ? "ok" : ""}`);
    // Report only cells with enough aircraft AND a meaningful bad share.
    const jamming = [];
    for (const [key, c] of jam) {
      if (c.total < 5) continue;
      const frac = c.bad / c.total;
      if (frac < 0.25) continue;
      const [la, lo] = key.split(",").map(Number);
      jamming.push([la + 0.5, lo + 0.5, +frac.toFixed(2), c.total]);
    }
    try {
      await pushJson("/api/jamming", { jamming }, "jamming");
      console.log(`[${new Date().toISOString()}] jamming: pushed ${jamming.length} suspect cells → ok`);
    } catch (e) { console.error(`jamming push failed: ${e.message}`); }
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
const DISASTERS_EVERY_MS = 30 * 60_000;
const GDACS_TYPES = { FL: "FL", DR: "DR", TC: "TC", WF: "WF" }; // drop EQ (USGS covers quakes)
const ALERT = { Green: 0, Orange: 1, Red: 2 };
async function sweepDisasters() {
  try {
    const r = await fetch("https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP", { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`GDACS HTTP ${r.status}`);
    const j = await r.json();
    const out = [];
    for (const f of j.features || []) {
      const p = f.properties || {}, g = f.geometry || {};
      if (!GDACS_TYPES[p.eventtype]) continue;
      const c = g.coordinates;
      if (!Array.isArray(c) || c.length < 2) continue;
      const sd = p.severitydata || {};
      out.push([
        +(+c[1]).toFixed(2), +(+c[0]).toFixed(2), p.eventtype, ALERT[p.alertlevel] ?? 0,
        String(p.name || "").slice(0, 60), String(p.country || "").slice(0, 40),
        String(p.fromdate || "").slice(0, 10), String(sd.severitytext || "").slice(0, 40),
      ]);
    }
    // Red first, then orange — most severe stays if we ever cap.
    out.sort((a, b) => b[3] - a[3]);
    await pushJson("/api/disasters", { disasters: out }, "disasters");
    console.log(`[${new Date().toISOString()}] disasters: pushed ${out.length} GDACS events → ok`);
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

console.log("fleet agent running — ships 45s · planes+jamming now · fires 15s · conflicts 30s · disasters 20s · projects 40s");
