// /api/jamming — GPS-interference grid derived from OUR plane sweep. gpsjam.org
// does the same from ADS-B: aircraft under GPS jamming broadcast a valid
// position but a degraded navigation-integrity category (low NIC / NACp). The
// agent aggregates airborne aircraft into 1° cells and reports cells where a
// meaningful share report bad nav. Row format:
//   [lat, lon, badFrac, total]   (cell center, 0–1 degraded share, aircraft count)
import { makeSnapshotHandler } from "../_lib/snapshot.js";
export const onRequest = makeSnapshotHandler("jamming", "jamming", 4000, 1800, 60);
