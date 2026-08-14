# The board — one retrieval surface over everything

*Built 13 August 2026. Wave 1 is live: the three agents, the monitor, the
charts, the news and the bias.*

`/board` on the site, `/api/board` as the endpoint, `src/lib/board/` as the part
that can be tested without a network. Later the chat sits on top of it, and the
catalog IS its tool list — no per-tool work.

---

## Why it exists, in numbers

Measured against production on 13 Aug 2026:

| Endpoint | Bytes | What that is |
|---|---|---|
| `/api/argus` | **171 KB** | ledger 110 KB (98 trades × 45 fields), journal 42 KB, state 5 KB |
| `/api/news` | **82 KB** | 150 items |
| `/api/kronos` + `/api/arena` | 17 KB | small enough to read whole |
| **together** | **270 KB** | ≈ 68k tokens for one "what is going on" |

The same ten questions through the board: **6.4 KB of digest**, or 4.5 KB for the
three-read batch the page opens with. The ledger is at 98 of its 500-trade cap,
so the raw side grows to ~620 KB and the digest side does not.

**That is the whole design.** A resource that forwards its source has done
nothing; every one of them selects and aggregates, and the aggregation calls the
modules the agents already use (`argus/learn.js`, `argus/core.js`) so the board
can never quietly disagree with `/argus` about the same number.

## What it does not do

Read-only. Argus's command channel (close / cancel / reset) stays in
`/api/argus`. A read-only allowlist can be public; an action surface cannot, and
mixing them is how a convenience layer becomes an incident.

## The security shape

`/api/argus` once bound an arbitrary `what` parameter into a D1 key lookup,
which let a public caller read private rows — CWE-639, fixed by denying
everything but one fixed key. A layer whose purpose is "everything from one
place" repeats that bug at ten times the surface unless it is built the other way
round, so:

- Sources are **named constants**. The three D1 keys are asserted by a test.
- Arguments go through a **closed schema**: unknown keys are refused rather than
  ignored, enums are closed, limits clamp, symbols match a ticker character class.
  (The first version of that class accepted `../../etc/passwd`, because symbols are
  interpolated into a Yahoo URL path. A test caught it before it shipped.)
- Visibility is **inherited**, never invented: a resource is public only if its
  source is already a public display today.

## Files

| File | What it holds |
|---|---|
| `src/lib/board/catalog.js` | every resource: summary, visibility, source, arg schema, pure `select`, pure `digest` |
| `src/lib/board/args.js` | the coercion, and the reason it is strict |
| `src/lib/board/format.js` | digest vocabulary; also `toMs()`, which fixes the Argus-milliseconds / Kronos-seconds trap at the edge |
| `src/lib/universe.js` | the monitor's instrument list, now shared with the board |
| `functions/api/board.js` | the only part that needs the network: fetch, gate, memoise per request |
| `src/pages/Board.jsx` | the overview plus the inspector |
| `src/lib/board/ask.js` | the chat as pure functions: catalog prompt, plan parsing, answer prompt |
| `functions/_lib/board.mjs` | the network half — fetching and gating — shared by `/api/board` and `/api/ask` |
| `functions/api/ask.js` | the two-turn chat endpoint |
| `test/board.test.mjs` · `test/ask.test.mjs` | 51 tests: the invariants, the coercion, every resource against a fixture, and the plan parsing |

Adding a resource is one object in `RESOURCES`: `summary`, `visibility`,
`source`, `args`, `select`, `digest`. It then appears in the listing, the
inspector and (later) the chat's tools without another line anywhere.

## The resources — all three waves built

**Public (17)** · `argus.status` `argus.positions` `argus.performance`
`argus.trades` `argus.lessons` `argus.journal` · `kronos.state` ·
`arena.state` · `market.quotes` `market.candles` `market.bias` ·
`news.headlines` `news.telegram` · `vol.iv` · `world.layers` `world.hazards` ·
`macro.yields`

**Admin (5)** · `cortex.state` `cortex.candidates` · `registry.strategies` ·
`portfolio.holdings` `portfolio.watchlist` · `ml.track`

The admin ones are the reason the visibility gate exists, and it is two locks:
the board refuses the resource to a public caller *before* fetching, and the
fetch carries the CALLER's cookie so `/api/lab`, `/api/library` and `/api/prefs`
still decide for themselves. A test asserts the implication — every resource
whose source is authenticated must be declared admin, because a public one would
fetch the dev's private data with the dev's own cookie and show it to anyone.

No source takes a channel argument. `lab?what=` and `prefs?key=` would put a
caller's string into an upstream query, so each channel is its own source with a
constant path and `key` / `what` do not exist as arguments at all. Two sources
fan out to several constant paths instead: `holdings` (positions + deposits,
because cash is derived and never stored) and `hazards` (fires + conflicts,
either half may fail without taking down the other).

## Ask — the chat, `/api/ask`

Not a tool-calling loop, on purpose. The app's LLM path is a fallback chain
across four providers whose free tiers are what keep a public endpoint free, and
each speaks a different tool protocol — so a tool loop would either bind the chat
to one provider or carry four implementations, and it could not run on the local
OmniRoute / CLI shim at all.

Instead, two strict-JSON turns, the same shape `/api/bias` and `/api/briefing`
already use:

1. **Plan** — the model sees the catalog (ids, summaries, argument types, ~3 KB)
   and returns which reads answer the question.
2. **Answer** — the board executes those reads and the model answers from the
   digests alone.

Three request shapes, so a LOCAL model can drive the same flow with no provider
key on the server: `{question}` runs it all server-side; `{question,
promptOnly:true}` hands back the planner prompt; `{question, plan}` executes a
plan and hands back the answer prompt. The page uses the local path whenever
OmniRoute or the CLI shim is configured.

Guardrails that are code, not prompt text: at most 6 reads per question, one
round, invented resource ids dropped before they cost a round trip, the planner
shown only what the caller may read (a public chat cannot learn the private
resources exist), and the reads travel back WITH the answer so the evidence is
inspectable next to the claim.

---

## Storage: does D1 suffice?

Yes, and not narrowly. Measured, not assumed:

- **Volume.** The entire production database is **778 KB** of a 5 GB free
  allowance. Factor 6,400 of headroom.
- **Row accounting.** D1 counts rows, not bytes — "a row that is 1 KB and a row
  that is 100 KB both count as one row". Reading the whole Argus snapshot costs
  exactly one of the 5,000,000 free daily row reads.
- **CPU.** Parsing + re-serialising the snapshot measures **0.48 ms** today and
  **1.49 ms** at the 500-trade cap (Node, same V8 as workerd). The Workers Free
  limit is 10 ms per request. The prior assumption — that parsing a large blob
  would be the binding constraint — was wrong by an order of magnitude, and is
  recorded here because a confident-sounding constraint that measurement does
  not support is exactly what this project keeps a list of.

What *would* need changing, in the order it will bite:

1. **The ledger's blob ceiling.** Everything is one JSON value per key, and a
   single D1 value has a documented ~2 MB cap. The 500-trade cap keeps us at
   ~620 KB. At 12 trades/day a year of trading is ~4,400 trades ≈ 5.5 MB — over
   it. Meta-labelling wants every trade forever (it needs ~272 more before it
   produces a model at all), so the ledger is the one thing that should become a
   real table: denormalised columns plus a `data` JSON blob, exactly the pattern
   `functions/api/library.js` already uses in this repo.
2. **History does not exist.** The snapshot is overwritten, so "what did equity
   do last week", "when did heat spike", "what was the agent thinking on Tuesday"
   are not answerable by anything, board or not. An append-only table fixes it:
   the agent persists every ~2 minutes → ~720 rows/day → a few MB a year, under
   1% of the free write budget.
3. **Not needed: a vector database.** Retrieval here is structured — filters and
   aggregates over trades, quotes and headlines, not semantic search. If text
   search over the news archive is ever wanted, SQLite FTS5 inside D1 is
   deterministic and free; a second datastore would buy nothing.
4. **Not D1 at all: training data.** Phase 2's Kronos fine-tune reads years of
   Binance klines — gigabytes. That belongs on the PC's disk, and R2 if it ever
   needs to leave it. Never D1.

---

## Found while building, not fixed

- **`tier: 1` in the news feed list means "official / wire-grade"** — the Fed,
  the SEC, the BLS — **and also the three PR Newswire feeds.** A `tier:1` filter,
  which should return the actual market movers, currently returns press releases
  about a music-education award. Changing it moves the News page too, so it is
  reported rather than silently reassigned.
- **The US yield archive has no nominal 10Y on its latest day**, only 10Y TIPS.
  The first version of `macro.yields` matched tenors by maturity days and so
  printed "2s10s −192 bp — inverted", which was an inflation-linked real yield
  subtracted from a nominal one. Now real and nominal are kept apart, the curve
  takes the latest observation per tenor, and any lagging tenor is dated in the
  output: "2s10s 11 bp (2Y as of 2026-07-24, 10Y as of 2026-07-01)".
- **`world.layers` reports ships at 0** — an empty layer is a stopped ingest, not
  a quiet world. The aisstream key is still missing.
- **The learning loop currently has 8 lessons and none of them positive**, even
  though London (+3.66R over 23 trades) and off-hours (+2.36R over 6) are the
  two profitable session buckets. Worth knowing why the winning side never
  becomes a lesson.
