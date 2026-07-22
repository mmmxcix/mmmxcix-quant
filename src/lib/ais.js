// ais.js — live vessel positions from aisstream.io (free personal API key),
// plus the TopoJSON decoder for the vendored world map (public/world-110m.json,
// Natural Earth / world-atlas, public domain).
//
// The browser connects DIRECTLY to wss://stream.aisstream.io — the key is the
// user's own free key, stored only in this browser's localStorage (same model
// as the IBKR gateway: personal data consumption, nothing ever touches our
// server or repo).

const KEY = "quant_ais_key";

export function getAisKey() {
  try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
}
export function setAisKey(k) {
  try { localStorage.setItem(KEY, (k || "").trim()); } catch { /* quota */ }
}

/** Decode a TopoJSON topology's `land` object into polygons of [lon,lat] rings. */
export function decodeLand(topo) {
  const { scale, translate } = topo.transform;
  const arcs = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => {
      x += dx; y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
  const ring = (arcIdxs) => {
    const pts = [];
    for (const i of arcIdxs) {
      const a = i >= 0 ? arcs[i] : [...arcs[~i]].reverse();
      // Consecutive arcs share their endpoint — skip the duplicate.
      for (let k = pts.length ? 1 : 0; k < a.length; k++) pts.push(a[k]);
    }
    return pts;
  };
  const polys = [];
  const walk = (g) => {
    if (g.type === "Polygon") polys.push(g.arcs.map(ring));
    else if (g.type === "MultiPolygon") for (const p of g.arcs) polys.push(p.map(ring));
    else if (g.type === "GeometryCollection") g.geometries.forEach(walk);
  };
  walk(topo.objects.land);
  return polys;
}

/** Web-Mercator projection to the unit square ([0,1]², y down). */
export const mercX = (lon) => (lon + 180) / 360;
export const mercY = (lat) => {
  const s = Math.max(-0.9999, Math.min(0.9999, Math.sin((lat * Math.PI) / 180)));
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/**
 * Open the aisstream feed. Returns { close, subscribe } — subscribe(bbox)
 * re-scopes the stream to [[latMin,lonMin],[latMax,lonMax]] on the same socket.
 * onStatus receives "connecting" | "live" | "closed" | "error".
 */
export function connectAis({ key, bbox, onPosition, onStatus }) {
  let ws = null, closed = false, lastBbox = bbox;

  const open = () => {
    onStatus?.("connecting");
    ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
    ws.onopen = () => {
      ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [lastBbox], FilterMessageTypes: ["PositionReport"] }));
      onStatus?.("live");
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.MessageType !== "PositionReport") return;
        const md = m.MetaData || {};
        const pr = m.Message?.PositionReport || {};
        const lat = md.latitude ?? pr.Latitude, lon = md.longitude ?? pr.Longitude;
        if (lat == null || lon == null) return;
        onPosition({
          mmsi: md.MMSI, name: String(md.ShipName || "").trim() || `MMSI ${md.MMSI}`,
          lat, lon, sog: pr.Sog ?? 0, cog: pr.Cog ?? pr.TrueHeading ?? 0, t: Date.now(),
        });
      } catch { /* malformed frame — skip */ }
    };
    ws.onerror = () => onStatus?.("error");
    ws.onclose = () => {
      onStatus?.("closed");
      // Auto-reconnect with a small backoff unless we closed on purpose.
      if (!closed) setTimeout(() => { if (!closed) open(); }, 3000);
    };
  };
  open();

  return {
    close: () => { closed = true; try { ws?.close(); } catch { /* already dead */ } },
    subscribe: (b) => {
      lastBbox = b;
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [b], FilterMessageTypes: ["PositionReport"] }));
      }
    },
  };
}

/** Named corridors — the choke points commodity flows actually squeeze through. */
export const CORRIDORS = [
  { id: "world", label: "World", bbox: [[-70, -180], [75, 180]] },
  { id: "suez", label: "Suez / Red Sea", bbox: [[10, 30], [33, 45]] },
  { id: "hormuz", label: "Str. of Hormuz", bbox: [[23, 52], [29, 60]] },
  { id: "singapore", label: "Singapore Str.", bbox: [[-2, 98], [7, 110]] },
  { id: "panama", label: "Panama Canal", bbox: [[5, -84], [12, -76]] },
  { id: "gibraltar", label: "Gibraltar", bbox: [[33, -9], [38, 1]] },
  { id: "channel", label: "English Channel", bbox: [[48, -7], [53, 4]] },
  { id: "shanghai", label: "Shanghai / ECS", bbox: [[27, 117], [35, 125]] },
];
