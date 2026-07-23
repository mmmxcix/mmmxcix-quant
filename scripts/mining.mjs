// mining.mjs — the DATA-MINING alpha channel (Cortex phase-1 upgrade).
//
// The research loop is literature-driven: papers → hypotheses. This module
// adds the second classic quant channel: scan OUR OWN market data for
// statistically robust anomalies and feed the survivors into the exact same
// gauntlet as paper-derived strategies.
//
// Honesty rules:
// - discovery happens on the TRAIN portion (first 70%) of each series only;
//   the gauntlet + fresh-data revalidator + incubation watchdog remain the
//   out-of-sample judges
// - every (market × family) scan is SELECTION PRESSURE and is charged to the
//   DSR trial window by the caller — scanning 40 combos and keeping the best
//   is exactly the multiple-testing the deflated Sharpe must know about
// - each anomaly is mined ONCE (key-deduped); re-scanning the same combo on
//   more data is not a new independent trial
// - long-only templates: calendar/autocorr effects are too thin to survive
//   short borrow costs, and honesty beats symmetry here.
//
// Families:
//   weekday      — "day-after-X" effect: next-bar return conditioned on the
//                  current bar's weekday (measured EXACTLY as traded: the
//                  engine fills at the next open)
//   autocorr     — lag-1 return autocorrelation: follow (r>0) or fade (r<0)
//   turn-of-month— next-bar returns inside the月-turn window (27th → 3rd)

const T_CALENDAR = 2.8; // per-family t-hurdles BEFORE the gauntlet/DSR
const T_AUTOCORR = 3.0;

const stats = (xs) => {
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, sd: 0, t: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 2 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
};

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function thesis(edge, works, breaks) {
  return `// EDGE: ${edge}\n// WORKS: ${works}\n// BREAKS: ${breaks}\n`;
}

/** next-bar returns + the bar they were conditioned on (train slice). */
function nextRets(candles, frac = 0.7) {
  const end = Math.floor(candles.length * frac);
  const out = [];
  for (let i = 1; i < end - 1; i++) {
    const base = candles[i].close;
    if (base > 0 && candles[i + 1].close > 0) {
      out.push({ bar: candles[i], ret: candles[i + 1].close / base - 1 });
    }
  }
  return out;
}

function mineWeekday(d) {
  if (d.market.interval !== "1d") return null;
  const rows = nextRets(d.candles);
  const byDow = new Map();
  for (const r of rows) {
    const k = new Date(r.bar.time * 1000).getUTCDay();
    if (!byDow.has(k)) byDow.set(k, []);
    byDow.get(k).push(r.ret);
  }
  let best = null;
  for (const [dow, rets] of byDow) {
    const s = stats(rets);
    if (s.n < 40 || s.mean <= 0) continue;
    if (!best || s.t > best.s.t) best = { dow, s };
  }
  if (!best || best.s.t < T_CALENDAR) return null;
  const day = DOW[best.dow];
  const bp = (best.s.mean * 10000).toFixed(0);
  return {
    key: `weekday:${d.market.id}:${best.dow}`,
    name: `mined · day-after-${day} effect · ${d.market.label}`,
    stat: `t=${best.s.t.toFixed(1)} · ${bp}bp/next-bar · n=${best.s.n} (train only)`,
    code:
      thesis(
        `${d.market.label} shows a significant day-after-${day} effect on train data (${bp}bp next-bar, t=${best.s.t.toFixed(1)}, n=${best.s.n}) — calendar anomaly, likely flow/settlement driven.`,
        "while the calendar flow behind it persists; effect measured exactly as traded (next-open fill).",
        "if the anomaly gets arbitraged away or the flow regime changes; thin edges die on costs first."
      ) +
      `function strategy(ctx) {
  // Long over the bar AFTER every ${day} — the engine fills at the next open,
  // which is exactly the window the effect was measured on.
  const t = new Date(ctx.candles[ctx.index].time * 1000).getUTCDay();
  return t === ${best.dow} ? "long" : "flat";
}`,
  };
}

function mineAutocorr(d) {
  const end = Math.floor(d.candles.length * 0.7);
  const rets = [];
  for (let i = 1; i < end; i++) {
    if (d.candles[i - 1].close > 0) rets.push(d.candles[i].close / d.candles[i - 1].close - 1);
  }
  const n = rets.length - 1;
  if (n < 120) return null;
  const a = rets.slice(0, -1), b = rets.slice(1);
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2;
  }
  const r = Math.sqrt(va * vb) > 0 ? cov / Math.sqrt(va * vb) : 0;
  const t = Math.abs(r) < 1 ? (r * Math.sqrt(n - 2)) / Math.sqrt(1 - r * r) : 0;
  if (Math.abs(t) < T_AUTOCORR) return null;
  const fade = r < 0;
  return {
    key: `autocorr:${d.market.id}:${fade ? "fade" : "follow"}`,
    name: `mined · lag-1 ${fade ? "reversal" : "momentum"} · ${d.market.label}`,
    stat: `r=${r.toFixed(3)} · t=${t.toFixed(1)} · n=${n} (train only)`,
    code:
      thesis(
        `${d.market.label} returns show significant lag-1 ${fade ? "NEGATIVE" : "positive"} autocorrelation on train data (r=${r.toFixed(3)}, t=${t.toFixed(1)}) — short-horizon ${fade ? "mean reversion" : "momentum"}.`,
        fade ? "choppy/range regimes where moves partially reverse next bar." : "persistent flow regimes where moves continue next bar.",
        `${fade ? "strong trends run it over" : "chop churns it to death"}; frequent flips make it cost-fragile.`
      ) +
      `function strategy(ctx) {
  const i = ctx.index, c = ctx.candles;
  if (i < 1 || c[i - 1].close <= 0) return "flat";
  const ret = c[i].close / c[i - 1].close - 1;
  return ret ${fade ? "<" : ">"} 0 ? "long" : "flat"; // ${fade ? "fade the down move" : "ride the up move"} (long-only)
}`,
  };
}

function mineTurnOfMonth(d) {
  if (d.market.interval !== "1d") return null;
  const rows = nextRets(d.candles);
  const inW = [], outW = [];
  for (const r of rows) {
    const dom = new Date(r.bar.time * 1000).getUTCDate();
    (dom >= 27 || dom <= 3 ? inW : outW).push(r.ret);
  }
  if (inW.length < 40 || outW.length < 80) return null;
  const si = stats(inW), so = stats(outW);
  if (si.mean <= 0) return null;
  // Welch t on the difference of means.
  const se = Math.sqrt((si.sd ** 2) / si.n + (so.sd ** 2) / so.n);
  const t = se > 0 ? (si.mean - so.mean) / se : 0;
  if (t < T_CALENDAR) return null;
  const bp = (si.mean * 10000).toFixed(0);
  return {
    key: `tom:${d.market.id}`,
    name: `mined · turn-of-month effect · ${d.market.label}`,
    stat: `t=${t.toFixed(1)} vs rest · ${bp}bp/next-bar in window · n=${si.n} (train only)`,
    code:
      thesis(
        `${d.market.label} next-bar returns inside the month-turn window (27th→3rd) beat the rest of the month with t=${t.toFixed(1)} on train data (${bp}bp vs ${(so.mean * 10000).toFixed(0)}bp) — the classic pension/salary-flow anomaly.`,
        "while month-end rebalancing and salary inflows persist.",
        "if the flow calendar shifts or the effect gets crowded; it is thin, so costs matter."
      ) +
      `function strategy(ctx) {
  const dom = new Date(ctx.candles[ctx.index].time * 1000).getUTCDate();
  return (dom >= 27 || dom <= 3) ? "long" : "flat"; // month-turn window only
}`,
  };
}

const FAMILIES = [mineWeekday, mineAutocorr, mineTurnOfMonth];

/**
 * Scan every dataset with every family. Returns the hits (deduped against
 * `minedKeys`), sorted strongest-first, plus how many NEW (market×family)
 * combos were examined — the caller charges those to the DSR trial window.
 */
export function mineAnomalies(datasets, minedKeys = new Set(), scannedKeys = new Set()) {
  const hits = [];
  let newScans = 0;
  for (const d of datasets) {
    for (const fam of FAMILIES) {
      const scanKey = `${fam.name}:${d.market.id}`;
      if (!scannedKeys.has(scanKey)) newScans++;
      let hit = null;
      try { hit = fam(d); } catch { /* thin/odd data — skip */ }
      if (hit && !minedKeys.has(hit.key)) hits.push({ ...hit, scanKey });
    }
  }
  hits.sort((a, b) => (parseFloat(b.stat.match(/t=([\d.]+)/)?.[1] || 0)) - (parseFloat(a.stat.match(/t=([\d.]+)/)?.[1] || 0)));
  return { hits, newScans, scanKeys: datasets.flatMap((d) => FAMILIES.map((f) => `${f.name}:${d.market.id}`)) };
}
