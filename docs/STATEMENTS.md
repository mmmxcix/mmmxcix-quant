# Statements → baskets — how it works

*Built 15 August 2026. What the chain actually pays is measured in
[STATEMENTS_FINDINGS.md](STATEMENTS_FINDINGS.md); this file is the machinery.*

The claim the tool is allowed to make is narrow on purpose:

> *"Trump said X. That points at these companies, for this reason. At N
> comparable statements, the basket's median move after five days was Y%, the
> spread was Z%."*

Not *"uranium stocks could benefit"*. The first sentence is checkable and the
second is a horoscope, and the only thing separating them is the event study at
the end.

---

## The chain

| step | where | what it does |
|---|---|---|
| statement | `src/lib/statements/parse.js` | who said it, when, in what words |
| theme | `src/lib/statements/themes.js` | a **fixed lexicon**, 22 themes, one stated mechanism each |
| basket | same file | US-listed tickers per theme |
| study | `src/lib/statements/study.js` | horizons 1/5/21d, median **and** spread, hit rate, shifted-date placebo |
| live | `scripts/statements-agent.mjs` → `/api/statements` | the same chain on today's feed |

## Two sources of statements, and they are not interchangeable

| | live | history |
|---|---|---|
| where | `/api/telegram` (MTProto + `t.me/s/` scrape) and `/api/news` | `t.me/s/<channel>?before=<id>`, paged backwards |
| reach | the last few hours | **Feb 2024 →**, ~34k messages on WalterBloomberg |
| built by | `scripts/statements-agent.mjs` | `scripts/statements-harvest.mjs` |

There is no archive endpoint for what a wire desk said two years ago, but the
public preview pages backwards one message id at a time. ~1,700 requests at one
a second is half an hour, once — which is how a study gets two years instead of
two weeks. Same split as the Form 4 project, for the same reason.

## Why the historical labelling is a regex and not a model

This is the most important decision in the project and it is worth stating
plainly: **a model classifying two-year-old headlines knows what happened next.**
There is no prompt that proves it did not lean on that, and a study whose
labelling step can see the future is not a study.

So every rule that touches the history is fixed, written from the mechanism
("who sells the thing the statement is about"), and readable in one file. Rerun
the script next month and the same headline lands in the same theme.

The model is used on the **live path only**, where the future genuinely is
unknown — and even there it is *recorded, not applied*:

- `themes` is the lexicon's answer. It is the only column a statistic may be
  attached to, because it is the one the findings were computed with.
- `model_themes` is what the LLM thought, stored beside it, plus an `agreement`
  label (`agree` / `model-wider` / `model-narrow` / `disagree` / `model-only`).

Swapping in a classifier that was never measured would silently invalidate every
number on the page. The disagreements are kept because they are the cheapest
available evidence that the fixed rules are drifting — the first live pass
already showed the gap clearly: the lexicon's roster is 22 senior names, and the
model surfaced Mark Cuban, Changpeng Zhao and Justin Sun, none of which any
measurement covers. Those rows are stored with an **empty** measured-theme list.

Same discipline as the Argus setup scorecard.

## The two timestamps, and the "priced in seconds" question

Telegram gives a real timestamp, so this study can be finer than the Form 4 one —
and it has to be stricter in the opposite direction:

- **reaction session** — the first session whose CLOSE falls after the statement.
  Where the market repriced. **Not tradeable, and labelled that way.**
- **entry** — the first session whose OPEN falls after it. A statement at
  06:00 UTC is tradeable that same morning; one at 14:00, mid-session, is not
  tradeable until the next open.

Reporting only the first would describe a profit nobody could take. Reporting
only the second would hide how much of the move was already gone.

Note the contrast with the Form 4 project, which had filing DATES with no time
of day: there the only safe rule was calendar-day granularity, and comparing raw
timestamps against a 13:30-stamped bar was worth a fictional Sharpe of 3.67.
Different data, different correct rule; the tests pin both.

## What a basket is, and what is wrong with it

A fixed list of US-listed tickers per theme, chosen for the mechanism and
cross-checked against IBKR's own relevance-ranked theme constituents. The
mechanism is written next to every one — if it cannot be said in a line
("detention capacity is contracted per bed, per night"), the theme does not
belong here.

**Membership is fixed as of August 2026, and that biases every result upward.** A
company is in the nuclear basket partly *because* the last two years went well
for it, and a company that went bankrupt inside the sample is in no basket at
all. The findings doc states this rather than burying it, and lists the basket
members that have no price history left (US Steel and CyberArk were both
acquired inside the sample — exactly the names that vanish).

Two refusals are enforced rather than warned about:

- a basket needs **4 priceable names** at an event, or the event does not count;
- a theme needs **30 priced events**, or its median is not allowed to mean
  anything. A theme whose basket can never field four names (immigration has
  two) is reported as *unmeasurable*, which is a different fact from *quiet*.

## Files

| file | what it holds |
|---|---|
| `src/lib/statements/parse.js` | speaker roster, the two headline grammars, repost de-duplication |
| `src/lib/statements/themes.js` | the 22 themes: match, veto, mechanism, basket |
| `src/lib/statements/study.js` | entry/reaction rules, basket pricing, summaries, the shifted-date placebo |
| `src/lib/statements/extract.js` | the two strict-JSON rounds and `reconcile()` |
| `scripts/statements-harvest.mjs` | pages `t.me/s/` backwards into `data/statements/` |
| `scripts/statements-validate.mjs` | the measurement; writes the findings |
| `scripts/statements-agent.mjs` | the live pass, run by `agent-daemon.mjs` |
| `functions/_lib/statements.mjs` · `functions/api/statements.js` | the D1 store and the endpoint |
| `db/statements-tables.sql` | the readable schema |
| `test/statements.test.mjs` | 26 tests |

The price primitives (candle indexing, the position stream, the liquidity
screen) are **imported from `src/lib/insider/study.js`**, not copied — two
implementations of a fill convention is a drift bug waiting to happen.

## The endpoint

```
GET  /api/statements?days=30&limit=100[&theme=nuclear][&speaker=trump]   public
GET  /api/statements?what=themes     the catalog: id, name, mechanism, basket
GET  /api/statements?what=stats      counts, freshness, lexicon-vs-model agreement
POST { token, statements[] }         machine token
```

It serves statements, themes and the mechanism behind each. **It serves no
number describing what a basket did afterwards** — that lives in the findings
doc, and until a theme survives the placebo there is deliberately nothing here a
page could use to imply the chain pays.

## Running it

```
node scripts/statements-harvest.mjs      # ~1h of polite paging, once
node scripts/statements-validate.mjs     # the measurement
node scripts/statements-agent.mjs --dry  # today's feed, pushes nothing
node scripts/statements-agent.mjs        # the real pass (needs LAB_TOKEN)
```

`agent-daemon.mjs` runs the agent every 30 minutes. `data/` is gitignored.

## Deliberately not built

**No page.** Step 5 of the brief was "a surface, but only once step 4 shows
something". See the findings doc for what step 4 said.

**No alerting.** An alert is a claim that something matters now, which is the
strongest claim in the whole chain and the one with the least support.
