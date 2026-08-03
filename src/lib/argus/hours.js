// argus/hours.js — market-hours gate so Argus behaves like a real day-trader and
// only scans/enters instruments whose market is actually open. Pure and TZ-aware:
// US equity hours are computed via the America/New_York timezone (Intl), so DST
// is honoured automatically rather than assuming a fixed UTC offset.
//   • crypto  → 24/7 (incl. weekends)
//   • stock   → regular session Mon–Fri 09:30–16:00 ET (weekends/holidays closed)
//   • forex   → Sun ~17:00 ET → Fri ~17:00 ET (closed over the weekend)
// See docs/DAYTRADER_AGENT.md ("crypto always, equities in RTH").

// Best-effort NYSE full-day closures (weekends handled separately). Observed
// dates for 2025–2026; a miss here just means Argus trades a holiday — harmless
// for paper, and the weekend + RTH gate is the must-have.
const US_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts in America/New_York for an instant, DST-correct. */
function nyParts(now) {
  const d = now instanceof Date ? now : new Date(now);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // some runtimes emit "24" for midnight under hour12:false
  const minute = parseInt(p.minute, 10);
  return {
    weekday: WEEKDAY[p.weekday] ?? 0,
    minutes: hour * 60 + minute,
    dateKey: `${p.year}-${p.month}-${p.day}`,
  };
}

const OPEN_MIN = 9 * 60 + 30;  // 09:30 ET
const CLOSE_MIN = 16 * 60;     // 16:00 ET
const FX_ROLL_MIN = 17 * 60;   // 17:00 ET weekly open/close

/**
 * Is the instrument's market open at `now`?
 * @param inst  { asset:"crypto"|"stock"|"etf"|"forex", symbol? }
 * @param now   Date (defaults to current time)
 */
export function marketOpen(inst, now = new Date()) {
  const asset = inst?.asset || "stock";
  if (asset === "crypto") return true; // 24/7, weekends included

  const { weekday, minutes, dateKey } = nyParts(now);

  if (asset === "forex" || asset === "futures") {
    // FX + CME futures: Sun ~17:00 ET → Fri ~17:00 ET, closed over the weekend.
    // (Futures take a short daily maintenance break we ignore — harmless for paper.)
    if (weekday === 6) return false;               // Saturday — closed
    if (weekday === 0) return minutes >= FX_ROLL_MIN; // Sunday opens 17:00 ET
    if (weekday === 5) return minutes < FX_ROLL_MIN;  // Friday closes 17:00 ET
    return true;                                   // Mon–Thu — ~24h
  }

  // stocks / ETFs (and any unknown asset) → US regular session.
  if (weekday === 0 || weekday === 6) return false; // weekend
  if (US_HOLIDAYS.has(dateKey)) return false;
  return minutes >= OPEN_MIN && minutes < CLOSE_MIN;
}
