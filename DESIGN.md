---
name: MMMXCIX Quant
description: A monochrome analytical terminal — frosted glass and drifting noise over a paper-to-graphite ramp, with only live market data allowed to carry color.
colors:
  paper: "#fafafb"
  paper-dark: "#0c0c0f"
  surface: "#ffffff"
  surface-dark: "#18181a"
  silver: "#e4e4e7"
  silver-dark: "#29292b"
  ink: "#0c0c0f"
  ink-dark: "#f4f4f5"
  dim: "#585860"
  dim-dark: "#9e9ea4"
  accent: "#18181a"
  accent-dark: "#fafafa"
  signal-up: "#0b6e47"
  signal-up-dark: "#4ac28c"
  signal-down: "#be2830"
  signal-down-dark: "#e85258"
  signal-warn: "#8a5e07"
  signal-warn-dark: "#e0af52"
typography:
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.2em"
    fontFeature: "uppercase"
  data:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  full: "9999px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "32px"
components:
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-accent-hover:
    backgroundColor: "{colors.accent}"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.dim}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  chip-active:
    textColor: "{colors.accent}"
    rounded: "{rounded.full}"
  chip-idle:
    textColor: "{colors.dim}"
    rounded: "{rounded.full}"
  input-base:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
---

# Design System: MMMXCIX Quant

## 1. Overview

**Creative North Star: "The Frosted Signal"**

Every quant tool has the same job: pull signal out of noise. This system makes that job literal. Underneath the interface sits a WebGL dither field and a fine grain layer — actual visual noise, drifting so slowly (a 96–120 second cycle) it registers as atmosphere, not motion. Over it sits frosted glass: panels that blur and saturate whatever noise sits behind them into a soft, present depth. Above all of that, the interface itself renders in exactly two non-negotiable colors — near-black ink on near-white paper by day, near-white ink on near-black paper by night — with a single rule standing guard: nothing on this screen is allowed to carry color except the market data itself. The accent isn't a brand hue borrowed from a style guide; the accent *is* the ink. When something turns green or red, that's not decoration, that's the answer to the only question a trader actually asked.

This is a **product register** system: the user is in a task (reading a chart, sizing a position, watching a backtest run), and the interface's job is to disappear into that task with the fluency of Linear or a Bloomberg terminal — not to perform a brand identity at them. It explicitly rejects the loud, gamified, glow-everywhere register of consumer trading apps: no rainbow category chips, no level-up celebration animation when a KPI ticks up, no mascot. Restraint is the whole point; a monochrome interface reads as more serious, not less, because the only thing left to notice is the data.

**Key Characteristics:**
- Two-color monochrome ramp (paper/ink) per theme; color is reserved entirely for up/down/warn market signals.
- Frosted glass over a slow WebGL dither + grain field — depth you feel, not decoration you notice.
- Inter for every UI surface; JetBrains Mono exclusively for live or historical numbers.
- Motion is short and task-length (page entry ≤0.3s), never a performance the user has to sit through.
- Every interactive state (hover/focus-visible/active/disabled) is explicit and consistent across all controls.

## 2. Colors

Monochrome by design — the palette is a single paper-to-ink ramp per theme, plus three semantic signal colors that are the only source of hue on the page.

### Primary
- **Graphite Ink** (`#18181a` light / `#fafafa` dark): the interface's only accent. Used for active nav state, primary button fills, focus rings, and the chart-accent gradient wash. Not a brand color — see the Named Rule below.

### Secondary — Signal Colors
- **Deep Signal Green** (`#0b6e47` light / `#4ac28c` dark): positive price movement, equity-curve fills, "live/armed" status pulse.
- **Deep Signal Red** (`#be2830` light / `#e85258` dark): negative price movement, loss states.
- **Dark Signal Ochre** (`#8a5e07` light / `#e0af52` dark): warnings, caution states. Both light-mode signal colors were deliberately deepened past their more "web-bright" first drafts (e.g. `#158f60`, raw `yellow-400`) because they washed out or fell below readable contrast on the near-white paper background.

### Neutral
- **Paper** (`#fafafb` light / `#0c0c0f` dark): the page background, painted on `<html>` only so the dither/ambient/grain layers beneath it stay visible.
- **Surface** (`#ffffff` light / `#18181a` dark): cards, inputs, the mobile drawer — one step off Paper.
- **Silver** (`#e4e4e7` light / `#29292b` dark): all hairline borders and dividers.
- **Ink** (`#0c0c0f` light / `#f4f4f5` dark): primary text.
- **Dim** (`#585860` light / `#9e9ea4` dark): secondary text, placeholders, disabled labels. Deliberately lightened/darkened past a "neutral gray" midpoint per theme so it stays legible against Paper/Surface rather than just looking muted.

### Named Rules
**The Accent-Is-Ink Rule.** There is no separate brand accent color. In light mode the accent is Graphite Ink; in dark mode it is near-white. The interface's only "color" is its own ink, at full opacity, on interactive elements — never a hue borrowed from a marketing palette.

**The One-Hue-Per-Fact Rule.** Green, red, and ochre are reserved exclusively for real market facts (price direction, warnings). They never appear as decoration, category-coding, or brand flourish — if a chip or badge needs color and isn't reporting a market fact, it doesn't get one.

## 3. Typography

**Body/UI Font:** Inter (with ui-sans-serif, system-ui fallback)
**Data/Numeric Font:** JetBrains Mono (with ui-monospace, SFMono-Regular fallback)

**Character:** One humanist sans carries every UI surface — nav, labels, prose, controls — at a fixed rem scale (no fluid clamp() sizing; this is a viewed-at-consistent-DPI tool, not a marketing page). A single monospace face is reserved, without exception, for anything that is a number a trader might read at a glance.

### Hierarchy
- **Title** (700, 1.125rem, 1.2 line-height, -0.01em tracking): page/section identity — the "Quant" wordmark, panel headers.
- **Body** (400, 0.875rem, 1.5 line-height): nav items, paragraph copy, form controls, general UI text.
- **Label** (600, 0.625rem, 0.2em tracking, uppercase): nav group headers ("MARKETS", "STRATEGY"), the "MMMXCIX" eyebrow, micro-annotations.
- **Data** (700, 1.5rem, 1.0 line-height, tabular-nums): KPI values, live prices, countdowns — always mono, always tabular so digits don't jitter as they update.

### Named Rules
**The Numerals-Are-Mono Rule.** Any value that is a number a user reads live or historically — prices, KPI figures, countdown timers, the ⌘K keyboard hint — renders in JetBrains Mono with `tabular-nums`. Everything else — labels, navigation, prose, buttons — stays in Inter. Mixing the two inside a sentence is the tell that a number is "real" data versus UI chrome.

## 4. Elevation

This system is neither flat nor shadow-heavy in the conventional sense — it's a **layered atmosphere**: three fixed background layers (an animated ambient gradient wash, a WebGL dither field, and a fine SVG-noise grain) sit behind the content at negative z-index, and frosted-glass panels on top of the content blur and saturate whatever noise is behind them into felt depth. Conventional box-shadow is reserved for two purposes only: the glass panel's own soft ambient shadow, and the extra shadow bloom a card gains on hover-lift. Nothing else casts a shadow.

### Shadow Vocabulary
- **Glass ambient** (light: `0 1px 2px rgba(12,12,15,0.05), 0 14px 34px -14px rgba(12,12,15,0.16)`; dark: `0 1px 2px rgba(0,0,0,0.55), 0 22px 46px -18px rgba(0,0,0,0.8)`): the resting shadow under every `.lg-glass` panel.
- **Hover-lift bloom** (`0 2px 6px rgb(ink/0.06), 0 24px 48px -20px rgb(ink/0.28)`, paired with a 3px upward translate and a brightened border): the only elevation change a card gets on hover — no scale, no rotation.

### Named Rules
**The Felt-Not-Seen Rule.** The ambient gradient glows and the dither/grain field must never be identifiable as an object on the page — they drift on 96–120 second cycles specifically so a user never catches them moving. If someone can point at the background and describe what it's doing, the effect is tuned too loud.

## 5. Components

### Navigation
Desktop: a fixed 224px frosted sidebar (`.lg-frost`, heavier saturation than card glass, for legibility as a persistent surface). Items group under three uppercase Label headers (Markets / Strategy / Learn). The active item gets a filled accent-tinted background plus a 3px accent bar on its left edge — the single consistent "you are here" affordance across the whole nav. Mobile: the sidebar collapses entirely below the `md` (768px) breakpoint into a top bar plus a slide-out drawer — a structural breakpoint, not a fluid-typography one, per product-register convention.

### Buttons
- **Shape:** `rounded-lg` (8px).
- **Primary (`btn-accent`):** ink-tinted fill at 15% opacity, ink border at 40% opacity, ink text — brightens to 25%/opacity fill on hover.
- **Secondary (`btn-ghost`):** surface background, hairline border, dim text that brightens to full ink on hover.
- **Hover / Focus / Active:** every button transitions color/background/border/transform over 150ms; on `:active` it scale-presses to 0.97 (collapses under `prefers-reduced-motion`); on `:focus-visible` it gets a 2px accent ring at 55% opacity, offset 2px, radius 6px — never shown on mouse click, always shown for keyboard.

### Chips
- **Style:** pill-shaped (`rounded-full`), 12px/4px padding, 12px text.
- **Active:** accent border + accent text + 10% accent fill.
- **Idle:** hairline border, dim text, a faint 5% ink fill so idle chips still read as clickable against the near-white ground (a bare hairline border alone was found to be nearly invisible in light mode).

### Inputs / Fields
- **Style:** surface background, hairline border, 8px radius, 12px/8px padding.
- **Focus:** border shifts to 50%-opacity accent; no glow, no shadow — the border color shift is the entire focus signal.

### Cards (KPI / Glass Panel)
- **Corner Style:** `rounded-xl` (12px).
- **Background:** `.lg-glass` — theme-aware translucent fill, `backdrop-filter: blur(16px) saturate(140%)`, plus a 1px specular hairline along the top edge.
- **Shadow Strategy:** see Elevation — ambient glass shadow at rest, hover-lift bloom on hover.
- **Internal Padding:** 16px.

### Signature Component: Live Data Treatment
Three small, deliberate patterns carry the "this data is alive" feeling, and they're the system's most distinctive visual signature:
- **Flash ticks** — a cell whose value just changed flashes a brief 22%-opacity up/down tint (0.6s ease-out) the way a trading terminal marks a print.
- **Self-drawing lines** — sparkline and equity-curve strokes animate in via `stroke-dashoffset` (normalized with `pathLength="1"`) over 0.7s, so a chart reads as being drawn rather than just appearing.
- **Pulse dot** — a live/armed status indicator ripples outward on a slow 2.4s cycle (`box-shadow` rings fading to transparent), always in the Signal Green.

### Signature Component: Command Palette
A ⌘K / Ctrl-K "Jump to…" trigger lives at the top of the sidebar on desktop and as an icon in the mobile bar — the fast-path navigation affordance for a tool with a dozen-plus routes, styled as a ghost input rather than a button.

## 6. Do's and Don'ts

### Do:
- **Do** keep color to exactly four roles: the ink/paper ramp, and up/down/warn signal colors. Nothing else earns a hue.
- **Do** render every live or historical number in JetBrains Mono with `tabular-nums`; keep every label, nav item, and button in Inter.
- **Do** keep page-entry motion at or under ~0.3s (`view-in` is 0.22s) and stagger children in ~30ms steps — a tool loads into a task, it doesn't perform an intro for the user.
- **Do** collapse every animation, transform, and the grain-layer opacity under `prefers-reduced-motion: reduce` — this system has zero exceptions to that rule today; don't ship one.
- **Do** give every interactive control all of default / hover / focus-visible / active / disabled — no half-implemented states.
- **Do** use `.lg-frost` (heavier saturation) for fixed chrome like the sidebar and top bar, and the lighter `.lg-glass` for in-content cards.

### Don't:
- **Don't** introduce a decorative brand accent color. The accent is the ink — see The Accent-Is-Ink Rule. If a design calls for "the app's color," the answer is graphite (light) or near-white (dark), not a new hue.
- **Don't** let the ambient glow, dither field, or grain layer become identifiable as a moving object — see The Felt-Not-Seen Rule. If a reviewer notices the background animating, slow it down or cut its opacity.
- **Don't** paint an opaque background on `<body>`. The background system depends on `<html>` alone carrying `--c-bg`, because CSS paints negative-z-index layers before in-flow block backgrounds — an opaque `<body>` silently hides the dither/ambient/grain stack entirely.
- **Don't** reach for a display/hero font size or a fluid `clamp()` heading. There is no display tier in this system; Title tops out at 1.125rem, deliberately, because this is a tool viewed at consistent DPI, not a landing page.
- **Don't** add gamified flourish — level-up glows, confetti, mascots, rainbow category coding — to any KPI, milestone, or empty state. That register belongs to consumer trading apps this system explicitly isn't.
