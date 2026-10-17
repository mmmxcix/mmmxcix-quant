# Daily briefing (planned, not built)

Goal: one page you read every morning to stay informed the way a research desk
is: primary data first, commentary second, every number with its source and
age. Built **entirely from the static snapshots** of the static-first pipeline
(`docs/STATIC_FIRST_AUDIT.md`, Phases 3–4). It is one more consumer of those
snapshots, not a new data path.

Status: **reserved**. This file fixes the structure so the Phase 3 producer
creates the right paths from day one. Nothing below is implemented.

## Shape
- **One JSON per day:** `briefing/daily/YYYY-MM-DD.json` in R2 (public custom domain, never behind a Worker), plus `briefing/daily/latest.json` pointing at the newest one.
  - Per-day files go to R2, not into the repo: daily history in git is exactly what the repo size guard is there to stop.
- **Assembly:** done by the **same scheduled GitHub Actions job** that writes the other snapshots, after the US close and again before the European open.
- **Client:** fetches **once per visit** and renders client-side. No `/api/*` call is involved.
- **Every panel carries** `{ source, asOf, status: "live" | "stale" | "down" }`, the same freshness rule as everywhere else. A failed input yields that panel with `status: "down"` and the previous day's values labelled, never an empty or invented panel.
- **Name clash to avoid:** the existing Briefing tab (`/news/briefing`, `src/pages/Briefing.jsx`) is the per-visitor LLM synthesis behind `/api/briefing`. The new page needs a different route (proposal: `/briefing/daily`), and `/api/briefing` is not reused. Once the daily file covers the same ground, the old tab either reads the file or is retired. That is decided in Phase 5.

## Reserved snapshot paths (stubs created in Phase 3)
| Path | Content | Source(s) | Cadence | Store |
|---|---|---|---|---|
| `macro/latest.json` | key series (rates, CPI, payrolls, claims, curve, dollar, credit spreads) + **ALFRED vintages** (first print vs. revised) | FRED / ALFRED (key as an Actions secret, never in the browser) | release days | committed |
| `calendar/week.json` | this week's releases, consensus where available, central-bank events | FRED release calendar, Fed/ECB calendars, LSE economic calendar (already integrated, keyed) | daily | committed |
| `positioning/cot.json` | CFTC Commitments of Traders, net positioning by market + percentile vs. 3y | CFTC public reports | weekly (Fri) | committed |
| `positioning/short-interest.json` | FINRA short interest for the fixed universes | FINRA | twice monthly | committed |
| `tape/latest.json` | indices, rates, FX, commodities, crypto: level, 1d/5d/1m change, 52-week position | Yahoo EOD (+ Stooq fallback), Binance | daily close + intraday copy in R2 | committed + R2 |
| `news/clusters/YYYY-MM-DD.json` | the day's headlines grouped into stories, one neutral summary each, with links | the 15 RSS feeds + `t.me/s` scrape (parsed in the job, never in a Worker) | 2× daily | R2 |

## Panels
| Panel | Fed by | Text by |
|---|---|---|
| 1. Tape: what moved | `tape` | template from numbers |
| 2. Macro: what printed vs. expected, what got revised | `macro` (incl. vintages) | template |
| 3. Calendar: what's coming this week | `calendar` | template |
| 4. Positioning: where the crowd is | `positioning/cot`, `positioning/short-interest` | template |
| 5. Volatility | existing IV snapshot (`/api/vol` data, moved to static) + BVOL | template |
| 6. News: the stories, not the stream | `news/clusters` | **LLM, in the job** |
| 7. Your book | the visitor's watchlist/portfolio (localStorage), joined client-side with `tape` | template, client-side |
| 8. Desk integrity: what's stale or down today | the `status` of every snapshot above | template |

## LLM use
- **Only panel 6 uses a model.** Everything else is templated from numbers, so the briefing is reproducible and costs nothing per visitor.
- The clustering and summarisation run **inside the scheduled job**, never in a Pages Function. Options, in order of preference:
  1. **Cloudflare Workers AI** via its REST API from the Actions job (free daily neuron allowance; account ID + an API token as Actions secrets).
  2. The free Groq/Gemini keys the site already uses.
- The output is stored, so a model outage means yesterday's clusters, labelled, not an empty panel.
- Your Claude subscription is not API access; the Anthropic API would be separate billing and isn't needed here.

## Not decided yet
- Exact FRED series list, and which releases count as "market-moving".
- Whether "Your book" also gets an emailed version (the existing digest worker could read `latest.json` instead of calling `/api/briefing`).
