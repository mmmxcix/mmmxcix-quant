# Responsiveness audit — mobile + desktop (notes, to fix later)

Code-level audit (Aug 2026). Not yet fixed — this is the punch-list. Verify each in
Chrome DevTools device toolbar at **390px** (phone), **768px** (tablet) and **2560px**
(ultrawide) before/after fixing.

## A. Global shell — `src/components/Layout.jsx`
- **Ultrawide wastes the right side.** `<main className="md:ml-56 p-3 sm:p-4 md:p-8 max-w-[1800px]">`
  (line ~323) caps content at 1800px but has **no `mx-auto`**, so on >~2000px screens the
  content hugs the left and leaves a big empty band on the right.
  → Fix: center the content area within the sidebar-offset region (add `mx-auto`, mind the
  `md:ml-56` offset), or raise/remove the cap for data-dense pages.
- Sidebar is a fixed `w-56` on `md:`, hamburger drawer on mobile — both fine.

## B. Mobile — charts trap the page scroll ("charts schwer zu scrollen")
This is the biggest mobile complaint. Interactive charts eat the vertical touch, so a swipe
that starts on a chart pans/zooms the chart instead of scrolling the page.
- **CandleChart** (`src/components/CandleChart.jsx`, lightweight-charts, the main price chart on
  `/charts`): captures vertical touch-drag by default.
  → Fix: `chart.applyOptions({ handleScroll: { vertTouchDrag: false }, handleScale: { pinch: true, mouseWheel: true } })`
  so **vertical swipes scroll the page**, horizontal drag / pinch still work on the chart.
  Also its height is fixed (`height` default 440) — use a responsive height on phones (e.g.
  ~280–320px) so the chart doesn't fill the whole viewport.
- **BrainVault** (`src/pages/BrainVault.jsx`, canvas force-graph): `touch-none` + `onTouchMove`
  `preventDefault()` **fully** trap touch — you can't scroll past it on mobile.
  → Fix: only `preventDefault` while a node is actually being dragged; otherwise let vertical
  touch scroll the page. Consider a shorter canvas + "tap to interact" gate on mobile.
- **WorldMap / Ships / Planes** (map canvases, `src/pages/WorldMap.jsx`, `Ships.jsx`, `Planes.jsx`):
  likely the same touch-trap — verify and apply the same "vertical scroll passes through" rule.
- **XYLineChart / MLStudio CurveChart**: `onMouseMove` / `onPointerMove` crosshair only, no
  `preventDefault` → low priority (a touch shows the crosshair but shouldn't block scroll).

## C. Mobile — tables overflow horizontally
These `<table>`s have **no `overflow-x-auto` wrapper**, so wide tables cause horizontal page
scroll / broken layout on phones (most other table pages already wrap — copy that pattern):
- `src/pages/MLRanking.jsx`
- `src/pages/MMSim.jsx`
- `src/pages/Monitor.jsx`
- `src/pages/Tools.jsx`
→ Fix: wrap each in `<div className="overflow-x-auto"> … </div>`.

## D. Desktop — pages that under-use the width ("nicht die ganze Seite genutzt")
`<main>` allows 1800px, but several pages self-constrain to a narrow column, leaving big empty
margins on desktop. Widen the **data / multi-panel** pages; **leave reading pages capped** (a
narrow measure is correct for prose).
- Widen (data/dashboards): **MLStudio** (`max-w-lg` somewhere), **EventLab** (`max-w-lg`),
  **Macro** (`max-w-lg`), **Portfolio** / **Watchlist** (`max-w-md`), **Coach** (`max-w-md`).
  → Use `lg:grid-cols-*` and a wider cap so charts/tables get room.
- Keep capped for readability: **Academy** lesson reader (`max-w-3xl`), **Formulas** (`max-w-2xl`),
  legal pages. A wide line length hurts reading — don't blindly widen these.
- Note: the per-page `max-w-xs`/`max-w-sm` matches from grep are mostly **inner** elements
  (inputs, cards), not the page container — confirm visually which pages are actually narrow.

## E. Mobile — misc to check
- Fixed chart heights (440px) dominate a phone screen → responsive height (`h-[280px] sm:h-[440px]`).
- Filter/chip rows (Backtest, Registry) use `flex-wrap` — probably OK, but verify they don't
  overflow at 390px.
- Confirm the mobile drawer lists every nav item (it renders `<NavItems/>` — should be fine).

## Quick test checklist (fix session)
1. Swipe vertically **starting on a chart** — does the page scroll? (B)
2. Any horizontal page scroll on a table page at 390px? (C)
3. At 2560px, is the content using the width or hugging the left? (A/D)
4. Do charts leave room to see content below them on a phone? (B/E)
