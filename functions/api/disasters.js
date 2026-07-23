// /api/disasters — GDACS natural-hazard events (floods, droughts, cyclones,
// wildfires) via the fleet agent. Row format:
//   [lat, lon, type, alert, name, country, fromdate, severity]
//   type: FL flood · DR drought · TC cyclone · WF wildfire  (EQ dropped — USGS covers quakes)
//   alert: 0 green · 1 orange · 2 red
import { makeSnapshotHandler } from "../_lib/snapshot.js";
export const onRequest = makeSnapshotHandler("disasters", "disasters", 1500, 7200, 300);
