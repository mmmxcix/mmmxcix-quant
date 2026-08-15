// Form 4 ingest, cluster detection, and the study harness.
//
// The properties worth pinning are the ones that would make a result WRONG
// rather than merely ugly:
//
//   · a cluster is dated by the last FILING, never by a transaction — dating it
//     by the trade date buys the reporting lag as if it were foresight, which is
//     the single mistake that would make this whole project look profitable
//   · a joint filing by three related entities is one decision, not a cluster
//   · the study enters the day AFTER the event and never reads a bar before it
//   · noise in produces nothing out, and a planted signal is actually found

import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import {
  blocks, compactDateToMs, extractOwnershipXml, isoToMs, joinDataset, normAccession,
  parseDailyIndex, parseForm4, parseSecTsv, purchases, purchaseValue, tsvDateToMs, valueOf,
} from "../src/lib/insider/form4.js";
import { clusterBuys, purchaseEvents } from "../src/lib/insider/cluster.js";
import {
  buildCalendar, calendarPortfolio, eligibleAt, eventStudy, indexCandles, nextTradingIndex,
  placebo, positionStream, seriesStats,
} from "../src/lib/insider/study.js";
import { unzip } from "../scripts/unzip.mjs";

const DAY = 86_400_000;

// ── fixtures ────────────────────────────────────────────────────────────────

/** One Form 4 with two owners and a mix of codes, in the real schema's shape. */
function form4Xml({ code = "P", shares = 1000, price = 12.5, ad = "A", date = "2026-03-02", owners = 1 } = {}) {
  const owner = (i) => `
    <reportingOwner>
      <reportingOwnerId>
        <rptOwnerCik>000000000${i}</rptOwnerCik>
        <rptOwnerName>Owner ${i}</rptOwnerName>
      </reportingOwnerId>
      <reportingOwnerRelationship>
        <isDirector>${i === 1 ? "true" : "false"}</isDirector>
        <isOfficer>${i === 1 ? "false" : "1"}</isOfficer>
        <isTenPercentOwner>false</isTenPercentOwner>
        <isOther>0</isOther>
        <officerTitle>${i === 1 ? "" : "CFO"}</officerTitle>
      </reportingOwnerRelationship>
    </reportingOwner>`;
  return `<ownershipDocument>
    <documentType>4</documentType>
    <periodOfReport>${date}</periodOfReport>
    <issuer>
      <issuerCik>0000123456</issuerCik>
      <issuerName>Acme Corp</issuerName>
      <issuerTradingSymbol>acme</issuerTradingSymbol>
    </issuer>
    ${Array.from({ length: owners }, (_, i) => owner(i + 1)).join("\n")}
    <nonDerivativeTable>
      <nonDerivativeTransaction>
        <securityTitle><value>Common Stock</value></securityTitle>
        <transactionDate><value>${date}</value></transactionDate>
        <transactionCoding>
          <transactionFormType>4</transactionFormType>
          <transactionCode>${code}</transactionCode>
          <equitySwapInvolved>0</equitySwapInvolved>
        </transactionCoding>
        <transactionAmounts>
          <transactionShares><value>${shares}</value></transactionShares>
          <transactionPricePerShare><value>${price}</value></transactionPricePerShare>
          <transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode>
        </transactionAmounts>
        <postTransactionAmounts>
          <sharesOwnedFollowingTransaction><value>50000</value></sharesOwnedFollowingTransaction>
        </postTransactionAmounts>
        <ownershipNature>
          <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
        </ownershipNature>
      </nonDerivativeTransaction>
      <nonDerivativeTransaction>
        <securityTitle><value>Common Stock</value></securityTitle>
        <transactionDate><value>${date}</value></transactionDate>
        <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>A</transactionCode></transactionCoding>
        <transactionAmounts>
          <transactionShares><value>9999</value></transactionShares>
          <transactionPricePerShare><value>0</value></transactionPricePerShare>
          <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
        </transactionAmounts>
      </nonDerivativeTransaction>
    </nonDerivativeTable>
    <derivativeTable>
      <derivativeTransaction>
        <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
        <transactionAmounts><transactionShares><value>777777</value></transactionShares></transactionAmounts>
      </derivativeTransaction>
    </derivativeTable>
  </ownershipDocument>`;
}

/** A filing in the shared normalized shape, built without going through XML. */
const filing = (o = {}) => ({
  accession: o.accession || "0000000001-26-000001",
  filedAt: o.filedAt, periodAt: o.boughtAt,
  issuerCik: o.issuerCik || "0000123456", issuer: "Acme Corp", symbol: o.symbol || "ACME",
  owners: (o.owners || ["0000000001"]).map((cik) => ({
    cik, name: `Owner ${cik}`, isDirector: false, isOfficer: true, isTenPercent: false, isOther: false, title: "CFO",
  })),
  trans: [{ date: o.boughtAt, code: o.code || "P", shares: o.shares ?? 10_000, price: o.price ?? 10, ad: o.ad || "A", after: 1, ownership: "D", security: "Common Stock" }],
});

// ── XML ─────────────────────────────────────────────────────────────────────

test("nested tags are matched at the right depth, not by the nearest closer", () => {
  const xml = "<a><b>1</b></a><a><a><b>2</b></a></a>";
  assert.deepEqual(blocks(xml, "a"), ["<b>1</b>", "<a><b>2</b></a>"]);
  assert.equal(valueOf("<transactionShares><value>42</value></transactionShares>", "transactionShares"), "42");
});

test("a Form 4 parses into the shared shape, and only non-derivative rows come with it", () => {
  const f = parseForm4(form4Xml({ owners: 2 }), { accession: "0001234567-26-000001", filedAt: Date.UTC(2026, 2, 4) });
  assert.equal(f.symbol, "ACME", "the ticker is upper-cased once, at the edge");
  assert.equal(f.issuerCik, "0000123456");
  assert.equal(f.owners.length, 2);
  assert.equal(f.owners[0].isDirector, true, "<isDirector>true</isDirector>");
  assert.equal(f.owners[1].isOfficer, true, "…and <isOfficer>1</isOfficer> means the same thing");
  assert.equal(f.owners[1].title, "CFO");
  assert.equal(f.trans.length, 2, "the derivative purchase is a different instrument and stays out");
  assert.equal(f.filedAt, Date.UTC(2026, 2, 4), "the filing date comes from the index; the XML has only the period");
});

test("only code P counts as a purchase — grants and exercises are payroll", () => {
  const buy = parseForm4(form4Xml({ code: "P" }), {});
  assert.equal(purchases(buy).length, 1);
  assert.equal(purchaseValue(buy).value, 12_500);
  assert.equal(purchaseValue(buy).shares, 1000, "the 9,999-share grant on the same filing is not a purchase");

  for (const code of ["A", "M", "F", "G", "S", "X"]) {
    assert.equal(purchases(parseForm4(form4Xml({ code }), {})).length, 0, `${code} must not count`);
  }
  // A "purchase" that disposed shares is a coding error, not a buy.
  assert.equal(purchases(parseForm4(form4Xml({ code: "P", ad: "D" }), {})).length, 0);
});

test("an unpriced purchase is counted in shares but reports how much was priced", () => {
  const f = parseForm4(form4Xml({ code: "P", price: 0 }), {});
  const v = purchaseValue(f);
  assert.equal(v.shares, 1000);
  assert.equal(v.value, 0);
  assert.equal(v.pricedShare, 0, "so a value floor can tell 'small' from 'unknown'");
});

test("Form 3 and Form 5 are refused — neither is an open-market decision", () => {
  assert.equal(parseForm4(form4Xml().replace("<documentType>4<", "<documentType>3<"), {}), null);
  assert.equal(parseForm4(form4Xml().replace("<documentType>4<", "<documentType>5<"), {}), null);
});

test("the ownership document is lifted out of a complete submission envelope", () => {
  const wrapped = `<SEC-DOCUMENT>hdr\n<XML>\n${form4Xml()}\n</XML>\n</SEC-DOCUMENT>`;
  const xml = extractOwnershipXml(wrapped);
  assert.ok(xml.startsWith("<ownershipDocument>") && xml.endsWith("</ownershipDocument>"));
  assert.equal(extractOwnershipXml("no filing here"), null);
});

// ── the daily index ─────────────────────────────────────────────────────────

test("the daily index yields Form 4s only, deduped across the issuer's and owner's lines", () => {
  const idx = [
    "Form Type   Company Name                            CIK         Date Filed  File Name",
    "-".repeat(80),
    "4           ACME CORP                               123456      20260813    edgar/data/123456/0001234567-26-000001.txt",
    "4           SMITH JOHN                              999999      20260813    edgar/data/999999/0001234567-26-000001.txt",
    "4/A         ACME CORP                               123456      20260813    edgar/data/123456/0001234567-26-000009.txt",
    "8-K         OTHER INC                               777777      20260813    edgar/data/777777/0000777777-26-000002.txt",
    "4           BETA LTD                                222222      20260813    edgar/data/222222/0002222222-26-000003.txt",
  ].join("\n");
  const rows = parseDailyIndex(idx);
  assert.equal(rows.length, 2, "one row per ACCESSION, and 4/A and 8-K are not Form 4");
  assert.equal(rows[0].accession, "0001234567-26-000001");
  assert.equal(rows[0].cik, "0000123456", "CIKs are padded so both sources join");
  assert.equal(rows[0].filedAt, Date.UTC(2026, 7, 13));
  assert.equal(rows[0].path, "edgar/data/123456/0001234567-26-000001.txt");
});

test("dates and accessions normalise to one form each", () => {
  assert.equal(compactDateToMs("20260813"), Date.UTC(2026, 7, 13));
  assert.equal(tsvDateToMs("31-MAR-2026"), Date.UTC(2026, 2, 31));
  assert.equal(isoToMs("2026-08-11"), Date.UTC(2026, 7, 11));
  assert.equal(normAccession("000123456726000001"), "0001234567-26-000001");
  assert.equal(tsvDateToMs("not a date"), null);
});

// ── the quarterly datasets ──────────────────────────────────────────────────

test("a TSV record split across lines by a free-text field is glued back together", () => {
  const tsv = [
    "ACCESSION_NUMBER\tTRANS_CODE\tNATURE_OF_OWNERSHIP",
    "0001234567-26-000001\tP\tBy the Smith Family",
    "Trust dated 1999",                       // continuation — no accession, so not a record
    "0001234567-26-000002\tS\tDirect",
  ].join("\n");
  const rows = parseSecTsv(tsv);
  assert.equal(rows.length, 2);
  assert.match(rows[0].NATURE_OF_OWNERSHIP, /Trust dated 1999/);
  assert.equal(rows[1].TRANS_CODE, "S");
});

test("the quarterly tables join into exactly the shape the XML parser produces", () => {
  const out = joinDataset({
    submission: [{ ACCESSION_NUMBER: "0001234567-26-000001", DOCUMENT_TYPE: "4", FILING_DATE: "04-MAR-2026", PERIOD_OF_REPORT: "02-MAR-2026", ISSUERCIK: "123456", ISSUERNAME: "Acme Corp", ISSUERTRADINGSYMBOL: "acme" },
      { ACCESSION_NUMBER: "0001234567-26-000002", DOCUMENT_TYPE: "3", FILING_DATE: "04-MAR-2026", ISSUERCIK: "123456", ISSUERTRADINGSYMBOL: "acme" }],
    owners: [{ ACCESSION_NUMBER: "0001234567-26-000001", RPTOWNERCIK: "42", RPTOWNERNAME: "Doe Jane", RPTOWNER_RELATIONSHIP: "Director,Officer", RPTOWNER_TITLE: "CEO" }],
    trans: [{ ACCESSION_NUMBER: "0001234567-26-000001", TRANS_DATE: "02-MAR-2026", TRANS_CODE: "P", TRANS_SHARES: "1000", TRANS_PRICEPERSHARE: "12.5", TRANS_ACQUIRED_DISP_CD: "A", DIRECT_INDIRECT_OWNERSHIP: "D", SECURITY_TITLE: "Common Stock" }],
  });
  assert.equal(out.length, 1, "the Form 3 in the same tables is dropped");
  const f = out[0];
  assert.equal(f.symbol, "ACME");
  assert.equal(f.filedAt, Date.UTC(2026, 2, 4));
  assert.equal(f.owners[0].cik, "0000000042");
  assert.ok(f.owners[0].isDirector && f.owners[0].isOfficer, "'Director,Officer' is both, read by substring");
  assert.equal(purchaseValue(f).value, 12_500);
});

// ── clustering ──────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 0, 5);

test("a cluster is dated by its LAST FILING, never by the transactions inside it", () => {
  // Two insiders buy on the same day; one files immediately, one files late.
  const { events } = clusterBuys([
    filing({ accession: "a-1", owners: ["0000000001"], boughtAt: T0, filedAt: T0 + 1 * DAY }),
    filing({ accession: "a-2", owners: ["0000000002"], boughtAt: T0, filedAt: T0 + 2 * DAY }),
  ], { windowDays: 10, minInsiders: 2, minValue: 0 });
  assert.equal(events.length, 1);
  assert.equal(events[0].knownAt, T0 + 2 * DAY, "the cluster was not knowable before the second filing landed");
  assert.equal(events[0].firstBuyAt, T0);
  assert.equal(events[0].maxLagDays, 2);
  assert.ok(events[0].knownAt > events[0].lastBuyAt, "acting on the trade date would be trading the reporting lag");
});

test("three related entities on ONE filing are one decision, not a cluster", () => {
  const joint = [filing({ accession: "j-1", owners: ["0000000001", "0000000002", "0000000003"], boughtAt: T0, filedAt: T0 + DAY })];
  assert.equal(clusterBuys(joint, { windowDays: 10, minInsiders: 2, minValue: 0 }).events.length, 0);
  assert.equal(clusterBuys(joint, { windowDays: 10, minInsiders: 2, minValue: 0, requireDistinctFilings: false }).events.length, 1,
    "…and the guard is a choice the caller can see, not a hidden rule");
});

test("purchases outside the window do not combine, and the same insider twice is still one insider", () => {
  const far = [
    filing({ accession: "b-1", owners: ["0000000001"], boughtAt: T0, filedAt: T0 + DAY }),
    filing({ accession: "b-2", owners: ["0000000002"], boughtAt: T0 + 30 * DAY, filedAt: T0 + 31 * DAY }),
  ];
  assert.equal(clusterBuys(far, { windowDays: 10, minInsiders: 2, minValue: 0 }).events.length, 0);

  const same = [
    filing({ accession: "c-1", owners: ["0000000001"], boughtAt: T0, filedAt: T0 + DAY }),
    filing({ accession: "c-2", owners: ["0000000001"], boughtAt: T0 + DAY, filedAt: T0 + 2 * DAY }),
  ];
  assert.equal(clusterBuys(same, { windowDays: 10, minInsiders: 2, minValue: 0 }).events.length, 0);
});

test("one buying spree fires once — the cooldown stops a wave becoming ten events", () => {
  const spree = [];
  for (let i = 0; i < 8; i++) {
    spree.push(filing({ accession: `d-${i}`, owners: [`000000000${i}`], boughtAt: T0 + i * DAY, filedAt: T0 + (i + 1) * DAY }));
  }
  const { events } = clusterBuys(spree, { windowDays: 10, minInsiders: 2, minValue: 0 });
  assert.equal(events.length, 1, `a single spree produced ${events.length} events`);
});

test("the value floor and the officers-only filter both bite, and both are reported", () => {
  const small = [
    filing({ accession: "e-1", owners: ["0000000001"], boughtAt: T0, filedAt: T0 + DAY, shares: 10, price: 1 }),
    filing({ accession: "e-2", owners: ["0000000002"], boughtAt: T0, filedAt: T0 + DAY, shares: 10, price: 1 }),
  ];
  const out = clusterBuys(small, { windowDays: 10, minInsiders: 2, minValue: 25_000 });
  assert.equal(out.events.length, 0);
  assert.equal(out.stats.rejectedBelowValue, 1, "a screen that reports only survivors cannot be checked");

  const holders = small.map((f) => ({ ...f, owners: f.owners.map((o) => ({ ...o, isOfficer: false, isDirector: false, isTenPercent: true })) }));
  assert.equal(clusterBuys(holders, { windowDays: 10, minInsiders: 2, minValue: 0, officersOnly: true }).events.length, 0);
  assert.equal(clusterBuys(holders, { windowDays: 10, minInsiders: 2, minValue: 0, officersOnly: false }).events.length, 1);
});

test("filings with no open-market purchase never reach the clustering at all", () => {
  const grants = [filing({ accession: "f-1", code: "A", boughtAt: T0, filedAt: T0 + DAY })];
  assert.equal(purchaseEvents(grants).length, 0);
});

// ── the study harness ───────────────────────────────────────────────────────

const SEC_DAY = 86_400;
// Bars are stamped at the US session open, exactly like Yahoo's daily data —
// which is the whole reason the day-vs-timestamp test below exists.
const SESSION_OPEN = Date.UTC(2024, 0, 2, 13, 30) / 1000;

/** A price series that drifts by `drift` per day, with OHLC that agree. */
function series({ days = 400, start = 100, drift = 0, t0 = SESSION_OPEN, volume = 200_000 } = {}) {
  const out = [];
  let px = start;
  for (let i = 0; i < days; i++) {
    const open = px;
    px *= 1 + drift;
    out.push({ time: t0 + i * SEC_DAY, open, high: Math.max(open, px), low: Math.min(open, px), close: px, volume });
  }
  return out;
}

/** The UTC midnight of a bar's day — how a Form 4 filing date arrives. */
const dayOf = (sec) => Math.floor(sec / SEC_DAY) * SEC_DAY * 1000;

test("a filing dated the same day as a bar enters the NEXT one — the bar is stamped at the open", () => {
  const cal = buildCalendar(series({ days: 10 }));
  // The bug this pins: a filing date is UTC midnight, a daily bar is 13:30 UTC.
  // Comparing the raw timestamps says the bar comes later, so the position would
  // enter at the open of the day the filing was not yet public.
  assert.equal(nextTradingIndex(cal, dayOf(cal.times[3])), 4, "same-day entry is trading before the filing existed");
  assert.equal(nextTradingIndex(cal, dayOf(cal.times[2])), 3);
  assert.equal(nextTradingIndex(cal, cal.times[3] * 1000), 4, "and a mid-session stamp on that day says the same");
  assert.equal(nextTradingIndex(cal, dayOf(cal.times[9])), -1, "no bar left is refused, not clamped");
});

test("the universe screen reads only bars before entry, and both floors bite", () => {
  const cal = buildCalendar(series({ days: 40 }));
  const liquid = indexCandles(series({ days: 40, start: 50, volume: 200_000 }));   // $10m/day
  const penny = indexCandles(series({ days: 40, start: 0.8, volume: 200_000 }));   // $160k/day, sub-dollar
  const thin = indexCandles(series({ days: 40, start: 50, volume: 200 }));         // $10k/day
  const t = cal.times[25];
  assert.equal(eligibleAt(liquid, t), true);
  assert.equal(eligibleAt(penny, t), false, "a sub-$5 name is not a fill, it is a tick");
  assert.equal(eligibleAt(thin, t), false, "$10k a day cannot absorb a position");
  assert.equal(eligibleAt(liquid, cal.times[0]), false, "no history before entry means no judgement");
});

test("a position reads only its own holding window, and pays the round trip once", () => {
  const bench = series({ days: 20, drift: 0 });
  const cal = buildCalendar(bench);
  const priced = indexCandles(series({ days: 20, drift: 0.01 }));
  const s = positionStream(cal, priced, 5, 3, 10);
  assert.equal(s.days.length, 3);
  assert.deepEqual(s.days, [5, 6, 7], "it never touches a bar before entry or after the horizon");
  // Day one is open→close minus 2×10 bps; the rest are close→close.
  assert.ok(Math.abs(s.ret[0] - (0.01 - 0.002)) < 1e-9);
  assert.ok(Math.abs(s.ret[1] - 0.01) < 1e-9);
  assert.equal(s.bench[0], 0, "the benchmark leg uses the same open→close convention on day one");
});

test("a planted signal is found, and pure noise is not", () => {
  const days = 600;
  const bench = series({ days, drift: 0 });
  const cal = buildCalendar(bench);
  // One symbol that compounds 1% a day, another that does nothing at all.
  const prices = { WIN: indexCandles(series({ days, drift: 0.01 })), FLAT: indexCandles(series({ days, drift: 0 })) };

  const hit = calendarPortfolio({
    events: [{ symbol: "WIN", knownAt: cal.times[99] * 1000 }], prices, cal, holdDays: 20, feeBps: 0,
  });
  assert.ok(seriesStats(hit.daily).totalPct > 15, "a 1%/day stretch that is held must show up");

  const miss = calendarPortfolio({
    events: [{ symbol: "FLAT", knownAt: cal.times[99] * 1000 }], prices, cal, holdDays: 20, feeBps: 0,
  });
  assert.ok(Math.abs(seriesStats(miss.daily).totalPct) < 1e-6, "a flat name must not manufacture a return");
});

test("a symbol with no price history is counted as dropped, never as a zero return", () => {
  const cal = buildCalendar(series({ days: 50 }));
  const pf = calendarPortfolio({
    events: [{ symbol: "GONE", knownAt: cal.times[10] * 1000 }, { symbol: "ALSOGONE", knownAt: cal.times[11] * 1000 }],
    prices: {}, cal, holdDays: 5,
  });
  assert.equal(pf.coverage.used, 0);
  assert.equal(pf.coverage.noPrice, 2, "the survivorship count is the number that has to be reported");
  assert.equal(seriesStats(pf.daily).totalPct, 0);
});

test("the placebo cannot beat a signal that is really there, and does beat one that is not", () => {
  const days = 700;
  const cal = buildCalendar(series({ days, drift: 0 }));
  // Ten names, each with a 20-day bump right after its own event.
  const prices = {}, events = [];
  for (let k = 0; k < 10; k++) {
    const c = series({ days, drift: 0 });
    const from = 100 + k * 40;
    for (let i = from; i < from + 20; i++) { c[i].open = 100; c[i].close = 100.8; c[i].high = 100.8; c[i].low = 100; }
    prices[`S${k}`] = indexCandles(c);
    events.push({ symbol: `S${k}`, knownAt: cal.times[from - 1] * 1000 });
  }
  const real = seriesStats(calendarPortfolio({ events, prices, cal, holdDays: 20, feeBps: 0 }).daily);
  const p = placebo({ events, prices, cal, holdDays: 20, feeBps: 0, realSharpe: real.sharpe, runs: 60, seed: 4 });
  assert.ok(p.pValue < 0.05, `a real, timed effect should not be reproduced by shuffling (p = ${p.pValue})`);

  // Same names, same dates, but the bumps removed: now the shuffle must match.
  const flat = {};
  for (let k = 0; k < 10; k++) flat[`S${k}`] = indexCandles(series({ days, drift: 0.0004 }));
  const nullReal = seriesStats(calendarPortfolio({ events, prices: flat, cal, holdDays: 20, feeBps: 0 }).daily);
  const nullP = placebo({ events, prices: flat, cal, holdDays: 20, feeBps: 0, realSharpe: nullReal.sharpe, runs: 60, seed: 4 });
  assert.ok(nullP.pValue > 0.05, `drift with no timing must NOT look significant (p = ${nullP.pValue})`);
});

test("the event study refuses a hold it cannot complete rather than reporting a short one", () => {
  const cal = buildCalendar(series({ days: 30 }));
  const prices = { ACME: indexCandles(series({ days: 30, drift: 0.005 })) };
  const near = { symbol: "ACME", knownAt: cal.times[27] * 1000 };   // only 2 bars left
  const out = eventStudy({ events: [near], prices, cal, horizons: [2, 10], feeBps: 0 });
  assert.equal(out[2].n, 1);
  assert.equal(out[10].n, 0, "a 10-day horizon with 2 days of data is not a 10-day observation");
});

// ── the archive reader ──────────────────────────────────────────────────────

test("the zip reader round-trips a stored and a deflated entry", () => {
  const files = [
    { name: "stored.txt", data: Buffer.from("hello"), method: 0 },
    { name: "deflated.txt", data: Buffer.from("x".repeat(5000)), method: 8 },
  ];
  assert.deepEqual([...unzip(makeZip(files)).entries()].map(([k, v]) => [k, v.toString()]),
    [["stored.txt", "hello"], ["deflated.txt", "x".repeat(5000)]]);
});

/** Minimal ZIP writer — only exists so the reader has something to be tested on. */
function makeZip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const f of files) {
    const body = f.method === 8 ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(f.method, 8);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(f.method, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
