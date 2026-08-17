// Consolidated hubs — related pages merged into one tabbed route each. Old
// routes redirect to the matching tab (see App.jsx).
//
// Each hub lives in its OWN module under ./hub/ and App.jsx lazy-imports them
// individually. When all five were exported from this one file they compiled
// into a single 432 kB chunk, so opening the News tab downloaded the
// backtester, the academy and the screener with it. This file is now only a
// convenience barrel for anything that wants them together.
export { default as BacktestHub } from "@/pages/hub/BacktestHub";
export { default as PortfolioHub } from "@/pages/hub/PortfolioHub";
export { default as ScreenerHub } from "@/pages/hub/ScreenerHub";
export { default as LearnHub } from "@/pages/hub/LearnHub";
export { default as MacroHub } from "@/pages/hub/MacroHub";
