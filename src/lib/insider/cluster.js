// cluster.js — several insiders of the same company buying within a few days.
//
// WHY THIS SHAPE AND NOT "follow the CEO". A single insider purchase is mostly
// noise: it can be a portfolio decision, a show of confidence staged for a press
// cycle, or a standing plan. What the literature keeps finding is the CLUSTER —
// independent insiders of the same issuer putting personal cash in at about the
// same time. It is harder to explain away, because the alternative stories
// (liquidity, diversification, optics) do not synchronise several people.
//
// Two dates matter and they are NOT the same one:
//
//   the TRANSACTION date, which is when the insiders actually agreed with each
//   other about the price, and therefore the date the clustering is measured on;
//
//   the FILING date, which is when the outside world could see it. An event
//   fires on the LATEST filing date among the filings that make up the cluster,
//   because before that moment the cluster was not knowable. Everything
//   downstream enters the day after. This is the whole reason the congressional
//   45-day rule is a trap and Form 4's two business days are not — and getting
//   it wrong is how a study invents an edge out of the reporting lag.
//
// This module decides NOTHING about whether the signal works. It produces the
// events; study.js measures them and is free to conclude that they are worthless.

import { padCik, purchaseValue, purchases, roleOf } from "./form4.js";

const DAY = 86_400_000;

export const DEFAULT_CLUSTER = {
  windowDays: 10,        // how close together the purchases must be
  minInsiders: 2,        // distinct reporting owners
  minValue: 25_000,      // total dollars, so a token 100-share gesture is not a "cluster"
  cooldownDays: 0,       // 0 = the window itself; one spree must not become ten events
  requireDistinctFilings: true,
  officersOnly: false,   // officers/directors only, dropping pure >10% holders
};

/**
 * A filing reduced to what clustering needs. Filings with no open-market
 * purchase are dropped here rather than filtered later, because "insider
 * activity" that is 95% grants and tax withholding would otherwise dominate
 * every count in the system.
 */
export function purchaseEvents(filings, { officersOnly = false } = {}) {
  const out = [];
  for (const f of filings || []) {
    const ps = purchases(f);
    if (!ps.length) continue;
    let owners = f.owners || [];
    if (officersOnly) owners = owners.filter((o) => o.isOfficer || o.isDirector);
    if (!owners.length) continue;
    // The economic date of the filing is its EARLIEST purchase; a filing that
    // reports several days of buying belongs to the first of them.
    let boughtAt = null;
    for (const t of ps) if (t.date != null && (boughtAt == null || t.date < boughtAt)) boughtAt = t.date;
    if (boughtAt == null) boughtAt = f.periodAt ?? f.filedAt;
    if (boughtAt == null || f.filedAt == null) continue;
    const v = purchaseValue(f);
    out.push({
      accession: f.accession,
      issuerCik: padCik(f.issuerCik),
      issuer: f.issuer,
      symbol: f.symbol,
      boughtAt,
      filedAt: f.filedAt,
      lagDays: Math.round((f.filedAt - boughtAt) / DAY),
      ownerCiks: owners.map((o) => o.cik),
      ownerNames: owners.map((o) => o.name),
      roles: owners.map(roleOf),
      value: v.value,
      shares: v.shares,
      pricedShare: v.pricedShare,
    });
  }
  return out.sort((a, b) => a.boughtAt - b.boughtAt || a.filedAt - b.filedAt);
}

/**
 * Find cluster buys.
 *
 * @param {Array} filings  normalized Form 4 filings (either source)
 * @param {object} opts    see DEFAULT_CLUSTER
 * @returns {{events: Array, stats: object}}
 *
 * Each event:
 *   { symbol, issuerCik, issuer, knownAt, firstBuyAt, lastBuyAt, insiders,
 *     filings, value, shares, roles, accessions, maxLagDays }
 *
 * `knownAt` is the date to act on. Nothing in this function ever reads a date
 * later than `knownAt`, which is the property test/insider.test.mjs pins.
 */
export function clusterBuys(filings, opts = {}) {
  const o = { ...DEFAULT_CLUSTER, ...opts };
  const cooldown = (o.cooldownDays > 0 ? o.cooldownDays : o.windowDays) * DAY;
  const win = o.windowDays * DAY;

  const byIssuer = new Map();
  for (const p of purchaseEvents(filings, { officersOnly: o.officersOnly })) {
    if (!byIssuer.has(p.issuerCik)) byIssuer.set(p.issuerCik, []);
    byIssuer.get(p.issuerCik).push(p);
  }

  const events = [];
  let singles = 0, belowValue = 0, jointOnly = 0;

  for (const [issuerCik, list] of byIssuer) {
    let lastFiredAt = -Infinity;
    // Sliding window over transaction dates. `i` is the oldest purchase still
    // inside the window that ends at `j`.
    let i = 0;
    for (let j = 0; j < list.length; j++) {
      while (list[i].boughtAt < list[j].boughtAt - win) i++;
      const slice = list.slice(i, j + 1);
      const ciks = new Set();
      for (const p of slice) for (const c of p.ownerCiks) ciks.add(c);
      if (ciks.size < o.minInsiders) { singles++; continue; }
      // Several related entities filing TOGETHER is one decision wearing three
      // hats — a fund, its general partner and its manager on a single Form 4.
      // Without this, the most common "cluster" in the data is one filing.
      const accessions = [...new Set(slice.map((p) => p.accession))];
      if (o.requireDistinctFilings && o.minInsiders >= 2 && accessions.length < 2) { jointOnly++; continue; }
      const value = slice.reduce((s, p) => s + p.value, 0);
      if (value < o.minValue) { belowValue++; continue; }

      // The event becomes knowable only when the LAST of its filings is public.
      const knownAt = Math.max(...slice.map((p) => p.filedAt));
      if (knownAt - lastFiredAt < cooldown) continue;   // still the same spree
      lastFiredAt = knownAt;

      const roles = [...new Set(slice.flatMap((p) => p.roles))];
      events.push({
        issuerCik,
        issuer: slice[slice.length - 1].issuer,
        symbol: slice[slice.length - 1].symbol,
        knownAt,
        firstBuyAt: slice[0].boughtAt,
        lastBuyAt: slice[slice.length - 1].boughtAt,
        insiders: ciks.size,
        filings: accessions.length,
        accessions,
        value,
        shares: slice.reduce((s, p) => s + p.shares, 0),
        roles,
        names: [...new Set(slice.flatMap((p) => p.ownerNames))],
        maxLagDays: Math.max(...slice.map((p) => p.lagDays)),
      });
    }
  }

  events.sort((a, b) => a.knownAt - b.knownAt);
  return {
    events,
    stats: {
      issuersWithPurchases: byIssuer.size,
      events: events.length,
      symbols: new Set(events.map((e) => e.symbol).filter(Boolean)).size,
      // Why the rest did not qualify — a screen that reports only its survivors
      // cannot be sanity-checked.
      rejectedSingleInsider: singles,
      rejectedJointFilingOnly: jointOnly,
      rejectedBelowValue: belowValue,
      opts: o,
    },
  };
}

/**
 * Roll-up per issuer for a live display: the most recent cluster and the raw
 * purchase/sale counts behind it. Descriptive only — no claim attached.
 */
export function issuerSummary(filings, opts = {}) {
  const { events } = clusterBuys(filings, opts);
  const latest = new Map();
  for (const e of events) {
    const prev = latest.get(e.issuerCik);
    if (!prev || e.knownAt > prev.knownAt) latest.set(e.issuerCik, e);
  }
  return [...latest.values()].sort((a, b) => b.knownAt - a.knownAt);
}
