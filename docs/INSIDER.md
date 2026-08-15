# Insider tracking — how it works

*Built 15 August 2026. The measurement that decides whether any of it is worth
acting on lives in [INSIDER_FINDINGS.md](INSIDER_FINDINGS.md); this file is the
machinery.*

Form 4 is what an officer, a director or a >10% holder must file within **two
business days** of trading their own company's stock. It is the cleanest free
dataset in this project: structured XML, a legal obligation behind it, no key, no
rate card. The congressional data (45-day deadline) is a different and much worse
problem and is deliberately not here yet — see the last section.

---

## The two sources, and why there are two

| | live | history |
|---|---|---|
| where | `sec.gov/Archives/edgar/daily-index/YYYY/QTRn/form.YYYYMMDD.idx` | `sec.gov/files/structureddata/data/insider-transactions-data-sets/YYYYqN_form345.zip` |
| lag | two business days | a quarter or more — **2026Q2 was still 404 on 15 Aug 2026** |
| cost | ~1,000 requests per trading day | one download per quarter |
| format | a path per filing; the submission `.txt` embeds the XML | TSV tables, already parsed |

Five years of history through the daily index would be roughly half a million
filings at one request each against a 10 req/s courtesy limit — seventeen hours
of downloading to answer one question. Five years through the quarterly datasets
is twenty downloads. So: **the daily index for what is happening, the quarterly
datasets for what happened.** Neither can do the other's job.

Both parsers emit the same object, so nothing downstream knows which one it is
reading:

```js
{ accession, filedAt, periodAt, issuerCik, issuer, symbol, owners[], trans[] }
```

`filedAt` is in **milliseconds**, like everything on the JS side of this repo
(the Argus-ms / Kronos-seconds trap is documented in the handoff and is exactly
the kind of thing that renders a marker 1000× too late and reports no error).

**SEC returns 403 to a default HTTP client.** It wants a real User-Agent with a
contact address. That is policy, not throttling, and it looks exactly like an
auth failure — the same trap that cost a session on the Kronos setup. Set
`SEC_USER_AGENT` if the default needs to change.

## Only code `P` is the signal

Form 4's transaction coding is the first place this can go quietly wrong:

| code | what it is | counted? |
|---|---|---|
| **P** | open-market or private **purchase** | **yes** |
| S | open-market sale | stored for context, never a buy signal |
| A | grant, award | no — compensation, not a decision |
| M | derivative exercise | no — usually paired with an S the same day |
| F | shares withheld for tax | no — an accounting artefact |
| G, D, C, X | gift, disposition to issuer, conversion, option exercise | no |

Roughly **8% of Form 4 filings contain a code-P purchase** (measured across
2021Q1–2026Q1: 73,596 of ~890,000). A tracker that counts "insider buying" with
A and M in it is mostly counting payroll, and payroll predicts nothing.

## What a cluster is

Several **distinct** reporting owners of one issuer buying inside a rolling
window. Two rules do the real work:

- **A cluster is dated by its last FILING, never by the transactions inside it.**
  Insiders agree with each other on a price on the transaction date; the outside
  world learns about it on the filing date. Entering on the transaction date
  buys the reporting lag and would make this whole project look profitable for
  the wrong reason. `test/insider.test.mjs` pins it.
- **Three related entities on one filing are one decision.** A fund, its general
  partner and its manager routinely file a single joint Form 4 with three
  reporting owners. Counting owners alone makes that the most common "cluster" in
  the data, so a cluster also needs ≥2 distinct accessions.

Plus a cooldown, so one buying spree is one event rather than ten overlapping
ones, and a value floor so a 100-share gesture is not a cluster.

The median cluster in the panel was knowable **3 days** after its first purchase.
That is the two-business-day deadline doing its job.

## Files

| file | what it holds |
|---|---|
| `src/lib/insider/form4.js` | both parsers, the transaction-code semantics, the shared filing shape |
| `src/lib/insider/cluster.js` | cluster detection; produces events, judges nothing |
| `src/lib/insider/study.js` | the calendar-time portfolio, the universe screen, the placebo, walk-forward |
| `scripts/unzip.mjs` | a zlib-only ZIP reader, so the SEC archives need no dependency |
| `scripts/insider-backfill.mjs` | downloads the quarterly datasets → `data/insider/<quarter>.json` |
| `scripts/insider-prices.mjs` | cached daily history from Yahoo, with throttling treated as throttling |
| `scripts/insider-validate.mjs` | the gauntlet; writes `docs/INSIDER_FINDINGS.md` |
| `scripts/insider-agent.mjs` | the daily ingest, run by `agent-daemon.mjs` |
| `functions/_lib/insider.mjs` · `functions/api/insider.js` | the D1 store and the endpoint |
| `db/insider-tables.sql` | the readable schema |
| `test/insider.test.mjs` · `test/insider-store.test.mjs` | 32 tests |

`data/` is gitignored: ~250 MB of SEC archives, the panel and the price cache,
all rebuildable.

## The endpoint

```
GET  /api/insider?what=clusters&days=90&limit=100[&symbol=XYZ]     public
GET  /api/insider?what=filings&days=7&limit=200[&purchases=1]      public
GET  /api/insider?what=stats                                       public
POST { token, filings[] } · { token, clusters[], clusterParams }    machine token
```

GET is public because every byte of it is already a public SEC filing — the
visibility rule from [BOARD.md](BOARD.md) is that a resource may be public only
if its source already is, and here it is by federal law.

The security shape is the one `/api/argus` had to learn: `what` is an allowlist
that denies by default (an open `what` once let a public caller read private D1
rows — CWE-639), limits clamp, the symbol must match a ticker character class,
and `purchases=1` selects between two fixed statements rather than contributing a
predicate.

The write path is token-gated and lives on the PC because the ingest is ~1,000
requests a day paced at 8/s — minutes of wall clock, which is nothing for a
long-lived agent and impossible inside a Worker's CPU budget.

## Running it

```
node scripts/insider-backfill.mjs        # once — ~250 MB, ~5 min
node scripts/insider-validate.mjs        # the measurement — rewrites the findings
node scripts/insider-agent.mjs --dry     # parse the last 3 published days, push nothing
node scripts/insider-agent.mjs           # the real pass (needs LAB_TOKEN)
```

The agent is scheduled by `agent-daemon.mjs` at 05:00 local, which is after the
SEC's overnight dissemination and before the US open.

## Deliberately not built yet

**No page, no alerting, no scoring.** The endpoint serves filings and clusters
and calls none of them a buy signal, because the measurement says the signal does
not survive the gauntlet. Building a screen that ranks clusters by "conviction"
would be making a claim this project has already tested and failed to support.

**No congressional data.** `disclosures-clerk.house.gov` is reachable and the
Senate has its EFD search, but the deadline there is **45 days**. Whatever the
periodic transaction reports contain, an outsider learns it a month and a half
late, and the Form 4 result above — where the lag is three days — is already
negative at every horizon past a week. Adding a source with fifteen times the lag
to a signal that fails at three days needs a reason, and "it is famous" is not
one. If it gets built, it gets built as an *aggregate* exposure measure (which
sectors is Congress net-long) and goes through the same script before it gets a
page.
