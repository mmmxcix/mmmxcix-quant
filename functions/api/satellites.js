// /api/satellites — curated orbital elements (CelesTrak TLEs) via the fleet
// agent. TLEs age over days, so the agent refreshes every ~8h. The browser
// propagates each satellite's sub-point with satellite.js (SGP4).
// Row format: [name, group, line1, line2]
import { makeSnapshotHandler } from "../_lib/snapshot.js";
export const onRequest = makeSnapshotHandler("satellites", "satellites", 1200, 43200, 1800);
