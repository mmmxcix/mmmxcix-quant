// marketHours.js — world-clock data layer.
//
// Every market carries its real IANA time zone, so daylight-saving shifts are
// handled by the browser's Intl database — no hand-maintained UTC offsets.
// Sessions are defined in LOCAL exchange minutes per weekday (0=Sun … 6=Sat),
// which is how exchanges themselves define them (NYSE opens 09:30 New York
// time regardless of what that is in UTC this month).
//
// Countdown math compares wall-clock minutes in the market's own zone. Across
// a DST switch inside the countdown window this can be off by an hour — the
// price of wall-clock definitions; status flips remain exactly correct.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MO_FR = (sessions) => ({ 1: sessions, 2: sessions, 3: sessions, 4: sessions, 5: sessions });
const ALL_WEEK = (sessions) =>
  ({ 0: sessions, 1: sessions, 2: sessions, 3: sessions, 4: sessions, 5: sessions, 6: sessions });

export const MARKET_CLOCKS = [
  {
    id: "nyse", city: "New York", exchange: "NYSE · Nasdaq", flag: "🇺🇸", tz: "America/New_York",
    hoursLabel: "09:30–16:00",
    days: MO_FR([[570, 960]]),
  },
  {
    id: "cme", city: "Chicago", exchange: "CME Globex (NQ/ES futures)", flag: "🇺🇸", tz: "America/Chicago",
    hoursLabel: "Sun 17:00 – Fri 16:00 · break 16–17",
    days: {
      0: [[1020, 1440]], // Sunday evening open
      1: [[0, 960], [1020, 1440]],
      2: [[0, 960], [1020, 1440]],
      3: [[0, 960], [1020, 1440]],
      4: [[0, 960], [1020, 1440]],
      5: [[0, 960]], // Friday closes 16:00 CT
    },
    breakLabel: "maintenance break",
  },
  {
    id: "crypto", city: "Crypto", exchange: "BTC · ETH — never closes", flag: "🌐", tz: "UTC",
    hoursLabel: "24/7",
    days: ALL_WEEK([[0, 1440]]),
    alwaysOpen: true,
  },
  {
    id: "six", city: "Zurich", exchange: "SIX Swiss Exchange", flag: "🇨🇭", tz: "Europe/Zurich",
    hoursLabel: "09:00–17:30",
    days: MO_FR([[540, 1050]]),
  },
  {
    id: "lse", city: "London", exchange: "London Stock Exchange", flag: "🇬🇧", tz: "Europe/London",
    hoursLabel: "08:00–16:30",
    days: MO_FR([[480, 990]]),
  },
  {
    id: "xetra", city: "Frankfurt", exchange: "Xetra", flag: "🇩🇪", tz: "Europe/Berlin",
    hoursLabel: "09:00–17:30",
    days: MO_FR([[540, 1050]]),
  },
  {
    id: "tse", city: "Tokyo", exchange: "Tokyo Stock Exchange", flag: "🇯🇵", tz: "Asia/Tokyo",
    hoursLabel: "09:00–11:30 · 12:30–15:30",
    days: MO_FR([[540, 690], [750, 930]]),
    breakLabel: "lunch break",
  },
  {
    id: "hkex", city: "Hong Kong", exchange: "HKEX", flag: "🇭🇰", tz: "Asia/Hong_Kong",
    hoursLabel: "09:30–12:00 · 13:00–16:00",
    days: MO_FR([[570, 720], [780, 960]]),
    breakLabel: "lunch break",
  },
  {
    id: "asx", city: "Sydney", exchange: "ASX", flag: "🇦🇺", tz: "Australia/Sydney",
    hoursLabel: "10:00–16:00",
    days: MO_FR([[600, 960]]),
  },
];

// Per-zone formatter cache (Intl.DateTimeFormat construction is expensive and
// this runs every second for nine markets).
const fmtCache = new Map();
function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  return fmtCache.get(tz);
}

/** Wall-clock parts of `date` in `tz`: { weekday 0-6, hour, minute, second }. */
export function localParts(tz, date) {
  const parts = {};
  for (const p of partsFormatter(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    weekday: WEEKDAYS.indexOf(parts.weekday),
    hour: +parts.hour,
    minute: +parts.minute,
    second: +parts.second,
  };
}

/**
 * Live status of one market at `date`.
 * @returns {{
 *   parts: {weekday,hour,minute,second},
 *   phase: "open"|"break"|"closed",
 *   minsToClose: number|null,      // open: minutes until this session ends
 *   minsToOpen: number|null,       // break/closed: minutes until next session
 *   nextOpenDay: string|null,      // weekday name when >20h away
 *   sessionProgress: number|null,  // 0..1 through the current session
 * }}
 */
export function marketStatus(market, date) {
  const parts = localParts(market.tz, date);
  const nowMin = parts.hour * 60 + parts.minute + parts.second / 60;
  const today = market.days[parts.weekday] || [];

  if (market.alwaysOpen) {
    return { parts, phase: "open", minsToClose: null, minsToOpen: null, nextOpenDay: null, sessionProgress: null };
  }

  // Inside a session right now?
  for (const [start, end] of today) {
    if (nowMin >= start && nowMin < end) {
      return {
        parts,
        phase: "open",
        minsToClose: end - nowMin,
        minsToOpen: null,
        nextOpenDay: null,
        sessionProgress: (nowMin - start) / (end - start),
      };
    }
  }

  // Closed: find the next session, scanning today then up to a week ahead.
  const hadSessionEarlierToday = today.some(([, end]) => nowMin >= end);
  for (let d = 0; d < 8; d++) {
    const day = (parts.weekday + d) % 7;
    const sessions = market.days[day] || [];
    for (const [start] of sessions) {
      const delta = d * 1440 + start - nowMin;
      if (delta > 0) {
        // Between two sessions of the same trading day = lunch/maintenance break.
        const isBreak = d === 0 && hadSessionEarlierToday;
        return {
          parts,
          phase: isBreak ? "break" : "closed",
          minsToClose: null,
          minsToOpen: delta,
          nextOpenDay: delta > 20 * 60 ? WEEKDAYS[day] : null,
          sessionProgress: null,
        };
      }
    }
  }
  return { parts, phase: "closed", minsToClose: null, minsToOpen: null, nextOpenDay: null, sessionProgress: null };
}

/** "2h 14m" / "16h 03m" / "2d 5h" — compact countdown for a minute delta. */
export function fmtCountdown(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m >= 48 * 60) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  return `${m}m`;
}

/**
 * The single next open/close event across all markets (crypto never has one).
 * @returns {{ market, action: "closes"|"opens", mins: number }|null}
 */
export function nextEvent(statuses) {
  let best = null;
  for (const { market, status } of statuses) {
    if (market.alwaysOpen) continue;
    const candidates = [];
    if (status.minsToClose !== null) candidates.push({ action: "closes", mins: status.minsToClose });
    if (status.minsToOpen !== null) candidates.push({ action: "opens", mins: status.minsToOpen });
    for (const c of candidates) {
      if (!best || c.mins < best.mins) best = { market, ...c };
    }
  }
  return best;
}
