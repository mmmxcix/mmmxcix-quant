// /api/projects — active World Bank development/construction projects,
// aggregated per country by the fleet agent. Row format:
//   [country, count, totalUsd, [topProjectNames]]
// The map pins each country's aggregate at its centroid ("Bauprojekte").
import { makeSnapshotHandler } from "../_lib/snapshot.js";
export const onRequest = makeSnapshotHandler("projects", "projects", 400, 14 * 86400, 3600);
