// form4.js — SEC Form 4 (insider transactions), read two ways into ONE shape.
//
// Form 4 is what an officer, a director or a >10% holder must file within two
// business days of trading their own company's stock. It is the cleanest free
// dataset in this project: structured XML, a short reporting lag, and a legal
// obligation behind it.
//
// There are two sources, and they answer different questions, so both are here:
//
//   LIVE — the daily index (`edgar/daily-index/YYYY/QTRn/form.YYYYMMDD.idx`)
//   lists every filing disseminated that day. Each Form 4 line points at a
//   complete submission `.txt`, which embeds the XML, so ONE request per filing
//   is enough. This is the only path with a two-day lag.
//
//   HISTORY — the SEC's own quarterly "Insider Transactions Data Sets"
//   (`files/structureddata/data/insider-transactions-data-sets/YYYYqN_form345.zip`)
//   ship the same filings already parsed into TSV tables, back to 2006. They lag
//   a quarter or more (2026Q2 was still 404 on 15 Aug 2026), which is useless
//   live and ideal for a study: 20 downloads instead of half a million.
//
// Both parsers emit the SAME filing object, so `cluster.js` and `study.js` never
// learn which source they are reading:
//
//   { accession, filedAt, issuerCik, issuer, symbol, owners[], trans[] }
//
// with `filedAt` in MILLISECONDS (this repo's Argus-vs-Kronos trap: everything
// on the JS side is ms) and every transaction carrying its own date, because a
// Form 4 may report trades from several days and the FILING date is the earliest
// moment anyone outside the company could have acted on it.
//
// Pure functions only — no fetching. The agent scripts do the network, these are
// testable in Node with a fixture.

// ── transaction codes ───────────────────────────────────────────────────────
// Form 4's Table I/II coding. Only ONE of these is the signal the literature is
// about, and confusing it with the others is the single easiest way to build a
// convincing insider tracker that measures nothing:
//
//   P  open-market or private PURCHASE      ← the signal
//   S  open-market or private sale          ← noisy: taxes, diversification, 10b5-1
//   A  grant, award or other acquisition    ← compensation, not a decision to buy
//   M  exercise of a derivative             ← usually followed by an S the same day
//   F  shares withheld to pay tax           ← an accounting artefact
//   G  gift        D  disposition to issuer     C  conversion     X  option exercise
//
// A "buy" that includes A/M/F is mostly payroll, and payroll does not predict
// anything. `P` alone is the open-market decision to put personal cash in.
export const CODE_PURCHASE = "P";
export const CODE_SALE = "S";

/** Human labels, for the UI and for report lines. */
export const CODE_LABEL = {
  P: "open-market purchase", S: "open-market sale", A: "grant/award",
  M: "derivative exercise", F: "tax withholding", G: "gift",
  D: "disposition to issuer", C: "conversion", X: "option exercise",
  V: "voluntary early report", J: "other", K: "equity swap", U: "tender",
};

// ── tiny XML reader ─────────────────────────────────────────────────────────
// Form 4's schema is shallow and regular, so a dependency-free reader is a few
// lines. It is depth-aware anyway: `<transactionAmounts>` nests elements that
// share names with siblings elsewhere, and a non-greedy regex would happily
// pair an opening tag with the wrong closing one.

/** Inner text of every `<tag>…</tag>` at any depth, in document order. */
export function blocks(xml, tag) {
  const open = `<${tag}>`, close = `</${tag}>`;
  const out = [];
  let i = 0;
  while (true) {
    const start = xml.indexOf(open, i);
    if (start < 0) break;
    let depth = 1, j = start + open.length;
    while (depth > 0) {
      const nextOpen = xml.indexOf(open, j);
      const nextClose = xml.indexOf(close, j);
      if (nextClose < 0) return out;                       // malformed — stop here
      if (nextOpen >= 0 && nextOpen < nextClose) { depth++; j = nextOpen + open.length; }
      else { depth--; j = nextClose + close.length; }
    }
    out.push(xml.slice(start + open.length, j - close.length));
    i = j;
  }
  return out;
}

/** Text of the FIRST `<tag>`, trimmed; "" when absent. */
export function field(xml, tag) {
  const b = blocks(xml, tag);
  return b.length ? b[0].trim() : "";
}

/**
 * Form 4 wraps most leaf data in `<tag><value>x</value></tag>` — the wrapper
 * also carries footnote references, which is why the value is not just the tag
 * text. Falls back to the raw text so a filer who omits `<value>` still parses.
 */
export function valueOf(xml, tag) {
  const b = blocks(xml, tag);
  if (!b.length) return "";
  const v = field(b[0], "value");
  return v || b[0].trim();
}

const boolOf = (s) => /^(1|true|y|yes)$/i.test(String(s).trim());
const numOf = (s) => {
  const n = Number(String(s).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
};

/** "2026-08-11" → ms at UTC midnight. Dates on Form 4 have no time of day. */
export function isoToMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** "31-MAR-2026" (the quarterly datasets' format) → ms at UTC midnight. */
export function tsvDateToMs(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(s).trim());
  if (!m) return null;
  const mon = MONTHS[m[2].toUpperCase()];
  return mon === undefined ? null : Date.UTC(+m[3], mon, +m[1]);
}

/** "20260813" (the daily index's format) → ms at UTC midnight. */
export function compactDateToMs(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s).trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

/** Normalise an accession to the dashed form both sources agree on. */
export function normAccession(s) {
  const d = String(s).replace(/[^0-9]/g, "");
  return d.length === 18 ? `${d.slice(0, 10)}-${d.slice(10, 12)}-${d.slice(12)}` : String(s).trim();
}

/** CIKs are zero-padded to 10 everywhere so the two sources join at all. */
export const padCik = (c) => String(c ?? "").replace(/[^0-9]/g, "").padStart(10, "0");

// ── the daily index ─────────────────────────────────────────────────────────

/**
 * Parse `form.YYYYMMDD.idx` and return the Form 4 filings only.
 *
 * The file is fixed-width-ish but not reliably so, and the last column is a
 * path with no spaces — so the form type is read from the line start and the
 * path from the line end, which is stable across the layout drift of 20 years.
 *
 * A Form 4 appears ONCE PER FILER (the issuer and each reporting owner get
 * their own line), so the same accession shows up two or three times. Deduped
 * here: downloading a submission twice is a wasted request against a 10 req/s
 * budget, and counting it twice would inflate every cluster.
 *
 * @returns {Array<{accession, form, cik, company, filedAt, path}>}
 */
export function parseDailyIndex(text, { forms = ["4"] } = {}) {
  const want = new Set(forms.map((f) => f.toUpperCase()));
  const seen = new Set();
  const out = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.startsWith("-")) continue;
    const form = line.slice(0, 12).trim().toUpperCase();
    if (!want.has(form)) continue;
    const parts = line.trim().split(/\s+/);
    const path = parts[parts.length - 1];
    if (!/^edgar\/data\/\d+\/[0-9-]+\.txt$/i.test(path)) continue;
    const filedAt = compactDateToMs(parts[parts.length - 2]);
    const cik = parts[parts.length - 3];
    const accession = normAccession(path.slice(path.lastIndexOf("/") + 1).replace(/\.txt$/i, ""));
    if (seen.has(accession)) continue;
    seen.add(accession);
    // Company name is whatever sits between the form type and the CIK column.
    const company = line.slice(12, line.lastIndexOf(cik)).trim();
    out.push({ accession, form, cik: padCik(cik), company, filedAt, path });
  }
  return out;
}

// ── one filing, from XML ────────────────────────────────────────────────────

/**
 * Pull the ownership document out of a complete EDGAR submission `.txt`. The
 * file is an SGML envelope with the XML inline; taking the document directly
 * saves the extra request the filing-directory listing would cost.
 */
export function extractOwnershipXml(submissionText) {
  const s = String(submissionText);
  const i = s.indexOf("<ownershipDocument>");
  if (i < 0) return null;
  const j = s.indexOf("</ownershipDocument>", i);
  return j < 0 ? null : s.slice(i, j + "</ownershipDocument>".length);
}

/**
 * Parse one Form 4 ownership document.
 *
 * @param {string} xml         the `<ownershipDocument>` element
 * @param {object} meta        { accession, filedAt } from the index — the XML
 *                             itself carries only `periodOfReport`, NOT the date
 *                             it was filed, and the filing date is the only one
 *                             an outsider could have traded on.
 * @returns {null|object} the shared filing shape, or null if it is not a Form 4
 */
export function parseForm4(xml, meta = {}) {
  if (!xml) return null;
  const docType = field(xml, "documentType");
  if (docType && docType !== "4") return null;   // Form 3 (initial) and 5 (annual) are different questions

  const issuerBlock = blocks(xml, "issuer")[0] || "";
  const owners = blocks(xml, "reportingOwner").map((o) => {
    const id = blocks(o, "reportingOwnerId")[0] || "";
    const rel = blocks(o, "reportingOwnerRelationship")[0] || "";
    return {
      cik: padCik(field(id, "rptOwnerCik")),
      name: field(id, "rptOwnerName"),
      isDirector: boolOf(field(rel, "isDirector")),
      isOfficer: boolOf(field(rel, "isOfficer")),
      isTenPercent: boolOf(field(rel, "isTenPercentOwner")),
      isOther: boolOf(field(rel, "isOther")),
      title: field(rel, "officerTitle"),
    };
  });

  // Non-derivative transactions only. A derivative purchase is an option trade
  // with a strike and an expiry — a different instrument, a different signal,
  // and mixing the two makes the share counts meaningless.
  const trans = [];
  for (const table of blocks(xml, "nonDerivativeTable")) {
    for (const t of blocks(table, "nonDerivativeTransaction")) {
      const coding = blocks(t, "transactionCoding")[0] || "";
      const amounts = blocks(t, "transactionAmounts")[0] || "";
      const post = blocks(t, "postTransactionAmounts")[0] || "";
      const nature = blocks(t, "ownershipNature")[0] || "";
      trans.push({
        date: isoToMs(valueOf(t, "transactionDate")),
        code: (field(coding, "transactionCode") || "").trim().toUpperCase(),
        shares: numOf(valueOf(amounts, "transactionShares")),
        price: numOf(valueOf(amounts, "transactionPricePerShare")),
        ad: (valueOf(amounts, "transactionAcquiredDisposedCode") || "").trim().toUpperCase(),
        after: numOf(valueOf(post, "sharesOwnedFollowingTransaction")),
        ownership: (valueOf(nature, "directOrIndirectOwnership") || "").trim().toUpperCase(),
        security: valueOf(t, "securityTitle"),
      });
    }
  }

  return {
    accession: normAccession(meta.accession || ""),
    filedAt: meta.filedAt ?? null,
    periodAt: isoToMs(field(xml, "periodOfReport")),
    issuerCik: padCik(field(issuerBlock, "issuerCik")),
    issuer: field(issuerBlock, "issuerName"),
    symbol: (field(issuerBlock, "issuerTradingSymbol") || "").trim().toUpperCase(),
    owners,
    trans,
  };
}

// ── the quarterly datasets ──────────────────────────────────────────────────

/**
 * Parse one of the SEC's TSV tables into row objects.
 *
 * Tab-separated with a header line and NO quoting — which means a free-text
 * field (REMARKS, NATURE_OF_OWNERSHIP) that contains a newline splits a record
 * across lines. Rather than guess, a line only starts a new record if its first
 * field looks like an accession number; anything else is glued onto the record
 * before it. That rule is exact for these files because every table's first
 * column IS the accession number.
 */
export function parseSecTsv(text) {
  const lines = String(text).split("\n");
  const header = (lines[0] || "").replace(/\r$/, "").split("\t");
  const isStart = (l) => /^\d{10}-\d{2}-\d{6}\t/.test(l);
  const rows = [];
  let buf = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line) continue;
    if (isStart(line)) { if (buf !== null) rows.push(buf); buf = line; }
    else if (buf !== null) buf += " " + line;             // continuation of a free-text field
  }
  if (buf !== null) rows.push(buf);
  return rows.map((r) => {
    const cells = r.split("\t");
    const o = {};
    for (let c = 0; c < header.length; c++) o[header[c]] = cells[c] ?? "";
    return o;
  });
}

/**
 * Join SUBMISSION + REPORTINGOWNER + NONDERIV_TRANS into the SAME filing shape
 * `parseForm4` produces, so a study cannot tell which source it is reading.
 *
 * Form 3 and Form 5 rows live in the same tables and are dropped here: a Form 3
 * is an initial holdings statement (no transaction at all) and a Form 5 is the
 * annual catch-up for things that did not need timely reporting. Neither is an
 * open-market decision.
 *
 * @param {object} tables  { submission: rows[], owners: rows[], trans: rows[] }
 * @returns {Array} filings, ascending by filing date
 */
export function joinDataset({ submission, owners, trans }) {
  const byAcc = new Map();
  for (const s of submission) {
    if (String(s.DOCUMENT_TYPE || "").trim() !== "4") continue;
    const acc = normAccession(s.ACCESSION_NUMBER);
    byAcc.set(acc, {
      accession: acc,
      filedAt: tsvDateToMs(s.FILING_DATE),
      periodAt: tsvDateToMs(s.PERIOD_OF_REPORT),
      issuerCik: padCik(s.ISSUERCIK),
      issuer: String(s.ISSUERNAME || "").trim(),
      symbol: String(s.ISSUERTRADINGSYMBOL || "").trim().toUpperCase(),
      owners: [],
      trans: [],
    });
  }
  for (const o of owners) {
    const f = byAcc.get(normAccession(o.ACCESSION_NUMBER));
    if (!f) continue;
    // RPTOWNER_RELATIONSHIP is a free-ish string: "Director", "Officer",
    // "Director,Officer", "10% Owner". Read it by substring, not by equality.
    const rel = String(o.RPTOWNER_RELATIONSHIP || "");
    f.owners.push({
      cik: padCik(o.RPTOWNERCIK),
      name: String(o.RPTOWNERNAME || "").trim(),
      isDirector: /director/i.test(rel),
      isOfficer: /officer/i.test(rel),
      isTenPercent: /10\s*%|ten\s*percent/i.test(rel),
      isOther: /other/i.test(rel),
      title: String(o.RPTOWNER_TITLE || "").trim(),
    });
  }
  for (const t of trans) {
    const f = byAcc.get(normAccession(t.ACCESSION_NUMBER));
    if (!f) continue;
    f.trans.push({
      date: tsvDateToMs(t.TRANS_DATE),
      code: String(t.TRANS_CODE || "").trim().toUpperCase(),
      shares: numOf(t.TRANS_SHARES),
      price: numOf(t.TRANS_PRICEPERSHARE),
      ad: String(t.TRANS_ACQUIRED_DISP_CD || "").trim().toUpperCase(),
      after: numOf(t.SHRS_OWND_FOLWNG_TRANS),
      ownership: String(t.DIRECT_INDIRECT_OWNERSHIP || "").trim().toUpperCase(),
      security: String(t.SECURITY_TITLE || "").trim(),
    });
  }
  return [...byAcc.values()].sort((a, b) => (a.filedAt || 0) - (b.filedAt || 0));
}

// ── derived facts every consumer needs ──────────────────────────────────────

/** Open-market purchases in a filing (code P, acquired). */
export function purchases(filing) {
  return (filing.trans || []).filter((t) => t.code === CODE_PURCHASE && t.ad === "A" && t.shares > 0);
}

/** Open-market sales in a filing (code S, disposed). */
export function sales(filing) {
  return (filing.trans || []).filter((t) => t.code === CODE_SALE && t.ad === "D" && t.shares > 0);
}

/**
 * Dollar value of the open-market purchases in a filing.
 *
 * A price of 0 is legitimate on some rows (a footnote gives a range instead of
 * a single price), so those shares are counted but contribute no value — and
 * `pricedShare` says how much of the filing was priced, which is what stops a
 * value threshold from silently dropping filings it cannot price.
 */
export function purchaseValue(filing) {
  const ps = purchases(filing);
  let value = 0, shares = 0, priced = 0;
  for (const t of ps) {
    shares += t.shares;
    if (t.price > 0) { value += t.shares * t.price; priced += t.shares; }
  }
  return { value, shares, pricedShare: shares > 0 ? priced / shares : 0, count: ps.length };
}

/** The strongest role on a filing — used to label a cluster, never to gate it. */
export function roleOf(owner) {
  if (owner.isOfficer) return "officer";
  if (owner.isDirector) return "director";
  if (owner.isTenPercent) return "10%";
  return "other";
}
