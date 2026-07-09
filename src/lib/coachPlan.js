// coachPlan.js — the personal roadmap shown on the private /coach page.
//
// Phases → tasks. Two task kinds:
//   * manual: checked off by hand, persisted in localStorage.
//   * course-linked: { course: "<courseId>" } auto-completes when every lesson
//     of that Academy course is marked done (academyProgress).
// Links: `to` = internal route, `href` = external (new tab). `lesson` builds
// an internal link into a specific Academy lesson.

import { COURSES } from "./academyContent";

const KEY = "quant_coach_done";
const listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

export function getCoachDone() {
  return read();
}

export function setCoachDone(taskId, done) {
  const set = read();
  if (done) set.add(taskId);
  else set.delete(taskId);
  try { localStorage.setItem(KEY, JSON.stringify([...set])); } catch { /* private mode */ }
  listeners.forEach((fn) => fn());
}

export function subscribeCoach(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** All lesson ids of a course, for auto-completion checks. */
export function courseLessonIds(courseId) {
  const c = COURSES.find((x) => x.id === courseId);
  if (!c) return [];
  return c.levels.flatMap((lvl) => lvl.lessons.map((l) => l.id));
}

const academyLink = (courseId, lessonId) =>
  lessonId ? `/academy?c=${courseId}&l=${lessonId}` : `/academy?c=${courseId}`;

export const COACH_PLAN = [
  {
    id: "phase-0",
    title: "Phase 0 — Know-how",
    subtitle: "Work through the Academy so every later decision is an informed one.",
    months: "now · ~4–6 weeks",
    cost: "CHF 0",
    tasks: [
      { id: "p0-quant", label: "Finish the Quant Foundations course", course: "quant-foundations", to: academyLink("quant-foundations"), detail: "Charts, indicators, backtesting, risk — the shared vocabulary for everything below." },
      { id: "p0-dt", label: "Finish the Day Trading course", course: "day-trading", to: academyLink("day-trading"), detail: "Intraday mechanics, sessions, and execution discipline." },
      { id: "p0-fp", label: "Finish the Futures & Prop-Firm course", course: "futures-prop", to: academyLink("futures-prop"), detail: "Your core track: futures math, prop rules, validation, the funded path." },
      { id: "p0-opt", label: "(Optional) Options & Derivatives course", course: "options-derivatives", to: academyLink("options-derivatives"), optional: true, detail: "Not needed for the prop path — useful general background." },
    ],
  },
  {
    id: "phase-1",
    title: "Phase 1 — Prototype & validate in the lab",
    subtitle: "Build ORB-style strategies here, where iteration is free — and learn to distrust good backtests.",
    months: "~1–2 months",
    cost: "CHF 0",
    gate: [
      "You can explain every line of your strategy code without help.",
      "The strategy survives out-of-sample: picked on one period/symbol, still positive on another.",
      "It has few parameters, and neighboring parameter values also work (plateau, not needle).",
    ],
    tasks: [
      { id: "p1-orb-run", label: "Run the ORB builder preset on BTCUSDT 5m and QQQ 5m", to: "/backtest", detail: "Backtest → Builder → 'Opening Range Breakout (Intraday)'. Study where it loses, not just the total." },
      { id: "p1-hypothesis", label: "Write your strategy hypothesis BEFORE tuning", lesson: academyLink("futures-prop", "fp-overfitting-ai"), detail: "Entry, stop, target, session, filters, and the economic 'why' — on paper, before touching parameters." },
      { id: "p1-build", label: "Build your own variant (builder or code, AI-assisted)", to: "/backtest", detail: "Use the code editor + AI generator. Count every variant you test — the count is your overfitting meter." },
      { id: "p1-oos", label: "Out-of-sample check on unseen data", lesson: academyLink("futures-prop", "fp-validation-toolkit"), detail: "Fit on one range, judge ONCE on another symbol/period. ≥50% of in-sample expectancy = pass." },
      { id: "p1-r", label: "Compute expectancy in R after costs", lesson: academyLink("futures-prop", "fp-expectancy-r"), detail: "+0.1R to +0.3R per trade after fees is a real edge. Judge variants by this, never by total return." },
    ],
  },
  {
    id: "phase-2",
    title: "Phase 2 — Futures simulator",
    subtitle: "Same strategy, real NQ/MNQ data, fake money. This phase is the cheap place to find every problem.",
    months: "~2–3 months",
    cost: "CHF 0–15/Mt.",
    gate: [
      "≥ 40 sim trades over ≥ 2 months, positive expectancy after costs.",
      "Max drawdown < 60% of the target prop firm's trailing loss limit at your size (1–2 MNQ).",
      "Rule-violation rate near zero (journal proves it).",
      "The trading window (NY open ≈ 15:30–17:30 CH time) fits your real daily life.",
    ],
    tasks: [
      { id: "p2-platform", label: "Set up a free futures sim (NinjaTrader and/or TradingView)", href: "https://ninjatrader.com", detail: "NinjaTrader is free for sim + backtesting with real futures data; TradingView paper trading works too." },
      { id: "p2-port", label: "Port the validated strategy to futures data (MNQ 5m)", detail: "Ask Claude to translate your lab strategy to Pine Script or NinjaScript and explain it line by line." },
      { id: "p2-rules", label: "Apply prop-firm rules to the sim yourself", lesson: academyLink("futures-prop", "fp-rules-drawdown"), detail: "Simulate the trailing drawdown and daily loss limit from day one — you're rehearsing the evaluation." },
      { id: "p2-journal", label: "Journal 40+ trades (screenshot, plan vs. actual, violations)", lesson: academyLink("futures-prop", "fp-sim-phase"), detail: "Every deviation from the written rules counts as an error regardless of P/L." },
      { id: "p2-mc", label: "Re-run the numbers: MC drawdown vs. loss limit", lesson: academyLink("futures-prop", "fp-validation-toolkit"), detail: "The 95th-percentile Monte-Carlo drawdown — not the single backtest — decides your size." },
    ],
  },
  {
    id: "phase-3",
    title: "Phase 3 — Evaluation",
    subtitle: "Only after Phase 2's gate is green. The eval changes nothing except that the fee is real.",
    months: "~1–4 months",
    cost: "~$50/Mt. (wait for discounts)",
    gate: [
      "Phase 2 gate fully met — no exceptions, no 'almost'.",
      "Written total budget (e.g. $400) and a written rule for what triggers retry vs. back-to-sim.",
      "You have read the firm's CURRENT rulebook, especially the automation policy.",
    ],
    tasks: [
      { id: "p3-firm", label: "Pick a firm & read the current rules (automation!)", href: "https://www.topstep.com", lesson: academyLink("futures-prop", "fp-automation-rules"), detail: "Topstep 50K is the usual start. Semi-automated with you present is the safe model; get automation questions answered in writing." },
      { id: "p3-budget", label: "Set the hard budget & failure rules in writing", lesson: academyLink("futures-prop", "fp-costs-timeline"), detail: "Decide now, while calm: total spend cap, and what sends you back to the simulator." },
      { id: "p3-trade", label: "Trade the eval: 1–2 MNQ, identical rules as sim", lesson: academyLink("futures-prop", "fp-eval-playbook"), detail: "Stop after 2 losses/day. No target pressure — slow is fine, blown is final." },
      { id: "p3-pass", label: "Pass → stop trading immediately, activate ($149)", detail: "Don't donate the pass back to variance. Activation ends the monthly fee." },
    ],
  },
  {
    id: "phase-4",
    title: "Phase 4 — Funded → own account",
    subtitle: "Cushion first, scale later, withdraw regularly. IBKR only after months of clean funded profitability.",
    months: "6+ months",
    cost: "data fees ~$30–60/Mt.",
    gate: [
      "Cushion above the drawdown floor > your strategy's 95th-percentile MC drawdown before any scaling.",
      "IBKR only after 6+ months net-profitable funded trading AND capital whose loss changes nothing.",
    ],
    tasks: [
      { id: "p4-cushion", label: "Build cushion at minimum size (1–2 MNQ)", lesson: academyLink("futures-prop", "fp-funded-phase"), detail: "First goal is not profit — it's making the trailing drawdown unreachable." },
      { id: "p4-payout", label: "First payout + fixed withdrawal schedule", detail: "Withdrawn money is the only money that is actually yours." },
      { id: "p4-review", label: "6-month review: net result after all fees", detail: "Clean process + negative net = real information about the strategy. Respect it." },
      { id: "p4-ibkr", label: "(Later) Own account at IBKR", lesson: academyLink("futures-prop", "fp-to-ibkr"), detail: "Keep the prop-firm limits as personal rules — they were protecting you. Automation becomes your own call here." },
    ],
  },
];
