import { useState } from "react";
import { Link } from "react-router-dom";
import {
  BookOpenCheck, ChevronDown, ChevronRight, LayoutDashboard, Activity, Radar,
  CandlestickChart, Sigma, Star, Briefcase, FlaskConical, Dices, Scale, Wrench,
  GraduationCap, Newspaper, Compass, Lightbulb, Route, Sparkles, Telescope,
} from "lucide-react";
import { cn } from "@/lib/utils";

// The user manual: what every page does, how the pieces connect, and the
// workflows that use the platform the way it was designed to be used.

// ── Page-by-page reference ──────────────────────────────────────────────────
const SECTIONS = [
  {
    id: "dashboard", icon: LayoutDashboard, title: "Dashboard", to: "/",
    what: "Your landing view: market pulse, the world market clock, and jump-offs into the rest of the app.",
    features: [
      "Quick market pulse across crypto and stock benchmarks (BTC, ETH, SPY, QQQ, big tech).",
      "World market clock: one live clock per exchange (NY, Chicago futures, Zurich, London, Frankfurt, Tokyo, Hong Kong, Sydney, crypto) with open/closed/lunch status, session progress, and countdowns to the next open or close.",
      "Click any symbol to open it in Charts.",
    ],
    tips: ["Use it as a 10-second orientation, then move to Monitor or your own Watchlist — those are the working views."],
  },
  {
    id: "monitor", icon: Activity, title: "Monitor", to: "/monitor",
    what: "A Bloomberg-terminal-style overview: panels of live quotes across crypto, US indices/ETFs, tech, and more — auto-refreshing.",
    features: [
      "Grouped quote panels with price and % change, colored by direction.",
      "Auto-refresh keeps the board current while the tab is open.",
      "Click any row to open the full chart.",
    ],
    tips: ["Keep Monitor open on a second screen (or phone) during the session as your market heartbeat."],
  },
  {
    id: "screener", icon: Radar, title: "Screener", to: "/screener",
    what: "Scans the whole crypto or stock universe for setups: momentum, RSI extremes, volume spikes, distance from highs.",
    features: [
      "Filters: RSI zones (oversold/overbought), % change, volume, market.",
      "Sortable columns — rank by what your strategy cares about.",
      "One click sends a hit to Charts for closer inspection.",
    ],
    tips: [
      "Screen for CONDITIONS your validated strategy needs (e.g. high relative volume for breakouts) — not for random 'hot' names.",
      "A screener finds candidates, never entries. The entry comes from your written rules.",
    ],
  },
  {
    id: "charts", icon: CandlestickChart, title: "Charts", to: "/charts",
    what: "The main charting workspace: candles for any crypto (Binance, real-time via WebSocket) or stock/ETF (Yahoo), from 1-second to monthly.",
    features: [
      "Intervals 1s–1M with infinite scroll into history; limited future scroll.",
      "Drawing tools: trend lines, horizontals (SL/TP), rays, rectangles, Fibonacci retracements — persisted per symbol.",
      "Magnet mode: the crosshair and every drawing snap onto the candles (exact O/H/L/C values) — no more eyeballing levels.",
      "Auto-draw: the app detects and draws support/resistance levels, trendlines, fair value gaps (FVG, with fill tracking), an automatic Fibonacci of the dominant swing, and double tops/bottoms — straight from the data.",
      "Overlays (SMA 20/50, EMA 200) and sub-panes (RSI, MACD).",
      "Price alerts: set above/below levels; the browser notifies you when they trigger (tab must stay open).",
      "Bias check: a fixed, mechanical rule set votes long/short/neutral on SEVERAL timeframes at once (each on the same fixed lookback), shows how aligned they are, derives stop/target suggestions from the detected structure, and estimates the time-to-target from ATR math — fully auditable, explicitly not investment advice.",
      "Crypto updates tick-by-tick over WebSocket; stocks poll the latest bar.",
      "The page remembers the last symbol and timeframe you viewed and reopens right there.",
    ],
    tips: [
      "Mark your levels the evening before; during the session you only execute.",
      "Alerts replace staring at the screen: set them at your entry/invalidations and walk away.",
      "Log scale (for long horizons) and the higher timeframe first — direction from the big chart, timing from the small one.",
    ],
  },
  {
    id: "options", icon: Sigma, title: "Options", to: "/options",
    what: "A live option-chain analyzer for US stocks/ETFs with a full position builder — the payoff of any multi-leg structure before you'd ever place it.",
    features: [
      "Real chains (calls/puts, IV, volume, open interest, computed Greeks) per expiry.",
      "Position builder: click legs together, add stock legs, or load presets (spreads, straddles, condors, butterflies…).",
      "Payoff diagram at expiry with breakevens, net cost, max profit/loss and aggregate position Greeks.",
      "Volatility smile and term-structure views for the selected expiry chain.",
    ],
    tips: [
      "Build the strategy in the Academy's options course first — every preset here has a lesson with the same diagram.",
      "Watch theta and IV of the whole position, not a single leg — the builder sums the Greeks for you.",
    ],
  },
  {
    id: "watchlist", icon: Star, title: "Watchlist", to: "/watchlist",
    what: "Your own symbol list with live quotes — crypto and stocks mixed, stored in this browser.",
    features: [
      "Add anything the search finds; remove with one click.",
      "Feeds your personalized newsletter digest (News page) with the symbols you follow.",
    ],
    tips: ["Keep it under ~15 symbols. A watchlist you can't scan in 30 seconds is a museum, not a tool."],
  },
  {
    id: "portfolio", icon: Briefcase, title: "Portfolio", to: "/portfolio",
    what: "A simulated portfolio: track positions with entry price and size, see live P/L — practice bookkeeping without real money.",
    features: [
      "Positions with cost basis, live value, absolute and % P/L.",
      "Edit or close positions anytime; data stays in this browser.",
      "Feeds the newsletter digest with your held symbols.",
    ],
    tips: ["Use it to rehearse position sizing from the Tools page: risk 1%, compute size, 'buy' here, journal the outcome."],
  },
  {
    id: "backtest", icon: FlaskConical, title: "Backtest", to: "/backtest",
    what: "The strategy lab: test rules against history on any symbol — no code needed (Builder) or full JavaScript (Code mode), with an honest, look-ahead-free engine.",
    features: [
      "Builder mode: SMA/EMA cross, RSI mean-reversion, momentum, Bollinger, Donchian, Opening Range Breakout — with adjustable parameters.",
      "Code mode: write strategy(ctx) in JS — long/short/flat, intrabar stop/target brackets, session times (UTC), persistent state; example templates included.",
      "AI generator (dev token): describe a strategy in plain language, get runnable code.",
      "Results: equity vs. buy & hold, trade markers on the price chart, full metrics (CAGR, Sharpe, max DD, win rate, profit factor, exposure).",
      "Monte Carlo panel under every result: bootstraps your actual trades into 1000 alternate orderings — P(loss), percentile fan, drawdown distribution vs. a prop-firm loss limit.",
      "Validation pipeline under every result: walk-forward analysis (builder) / k-fold consistency (code), Deflated Sharpe Ratio (corrects for how many variants you tried), and a price-noise robustness test — each with an explicit pass/fail verdict.",
      "Trade list with side, exit reason (signal/stop/target), duration and P/L per trade.",
    ],
    tips: [
      "Always include realistic fees (bps/side). A strategy that only works at zero cost doesn't work.",
      "Signals execute at the NEXT bar's open by design — that's not a bug, it's the absence of look-ahead cheating.",
      "Judge by expectancy and the Monte-Carlo 95th-percentile drawdown, never by total return alone.",
      "Count your variants: if the 14th tweak finally 'works', you've been fitting noise (Academy: overfitting lesson).",
    ],
  },
  {
    id: "registry", icon: BookOpenCheck, title: "Registry", to: "/registry",
    what: "Your strategy notebook: save backtests and move each through a lifecycle — Factory → Validated → Paper → Graveyard — with a correlation matrix.",
    features: [
      "Save any backtest (metrics + validation verdicts) from the Backtest page.",
      "Lifecycle columns: promote survivors, bury failures in the graveyard, revive later.",
      "Correlation matrix over validated/paper strategies — spot cluster risk before combining them.",
    ],
    tips: [
      "A strategy that passes all three validation checks lands straight in 'Validated'; everything else starts in 'Factory'.",
      "Aim for low correlations between paper strategies — teal cells (uncorrelated) mean they won't all lose on the same day.",
    ],
  },
  {
    id: "lab", icon: Dices, title: "Lab", to: "/lab",
    what: "The Monte-Carlo playground: define an edge as pure numbers (win rate, avg win/loss in R, risk per trade) and watch 1000 alternate histories of it.",
    features: [
      "Expectancy calculator with live verdict (is this edge even positive?).",
      "Equity percentile fan, drawdown histogram, and a prop-firm loss-limit breach check.",
      "Presets that teach: high-win-rate-but-losing edges, trend-follower profiles, oversizing disasters.",
    ],
    tips: [
      "Before coding any strategy, sanity-check its claimed stats here — many published 'edges' die in 30 seconds of simulation.",
      "The default 4% loss limit models a 50K prop account ($2,000 trailing drawdown). Your size is wrong until the red share is small.",
    ],
  },
  {
    id: "anomalies", icon: Telescope, title: "Anomalies", to: "/anomalies",
    what: "Six classic quant results recomputed live instead of retold: three published return anomalies over a 40-stock universe, plus three pieces of risk geometry.",
    features: [
      "Betting Against Beta: the full factor construction on live prices — rolling betas, monthly rebalance, levered low-β leg vs shorted high-β leg, equity curves vs SPY, and the 'flat security market line' scatter.",
      "Accruals (Sloan 1996): the whole universe ranked by (net income − operating cash flow) / assets from the latest annual filings — cash-backed vs paper earnings.",
      "Short Interest: short % of float, days-to-cover and month-over-month change per stock, with 'crowded' flags.",
      "Correlation Regimes: rolling average pairwise correlation across a 6-asset basket (stocks, bonds, gold, BTC) with stress shading, plus calm-vs-stress correlation matrices side by side.",
      "Drawdown Topology: thousands of fat-tailed Monte-Carlo paths rendered as a rotatable 3D drawdown surface, with quantile lines, terminal distribution and VaR.",
      "Greeks Manifold: the P&L, gamma and theta surfaces of calls, puts and straddles over spot × time — the option as the surface it actually is.",
      "Every module carries a 'reality check' box: what post-publication research says is left of the edge.",
    ],
    tips: [
      "Read the matching Academy course (Anomalies & Factor Investing) alongside — each tab has a lesson explaining the why.",
      "The point is calibration, not signals: these modules show how documented edges behave TODAY, costs excluded, on a small universe. Treat them as lenses, not trade lists.",
    ],
  },
  {
    id: "compare", icon: Scale, title: "Compare", to: "/compare",
    what: "Compare assets against each other: normalized performance, DCA simulation, and dividend-reinvestment growth.",
    features: [
      "Performance: multiple symbols indexed to a common start.",
      "DCA: what periodic buying would have done, vs. lump sum.",
      "Dividends: invested capital vs. price-only vs. dividends-reinvested growth curves.",
    ],
    tips: ["Compare over multiple ranges — rankings flip between 1y and 5y more often than you'd think."],
  },
  {
    id: "tools", icon: Wrench, title: "Tools", to: "/tools",
    what: "The day-trader utility belt: the small calculations you need constantly, done right.",
    features: [
      "Position size calculator (account, risk %, stop distance → size).",
      "Risk/Reward calculator and ATR-based stop calculator.",
      "Pivot points and a compounding calculator.",
    ],
    tips: ["Position size BEFORE every trade, from the calculator — never from feel. It's the one habit that keeps accounts alive."],
  },
  {
    id: "academy", icon: GraduationCap, title: "Academy", to: "/academy",
    what: "Structured courses from zero to self-sufficient: Quant Foundations, Day Trading, Futures & Prop-Firm Trading, Options & Derivatives, and Anomalies & Factor Investing.",
    features: [
      "Levels and lessons with progress tracking, diagrams, formulas, and 'in the tool' pointers.",
      "The Futures & Prop-Firm track is the roadmap course for funded trading (rules, validation, execution path).",
    ],
    tips: ["Work lessons in order and actually do the 'in the tool' steps — reading alone doesn't build the skill."],
  },
  {
    id: "news", icon: Newspaper, title: "News", to: "/news",
    what: "Aggregated market news, filterable by category and searchable — plus the email digest subscription.",
    features: [
      "Category filters and full-text search across sources.",
      "Newsletter: personalized digest built from your watchlist/portfolio symbols, chosen categories and sources (double opt-in).",
    ],
    tips: ["News explains moves after they happen — trade your rules, read the news for context, not for entries."],
  },
  {
    id: "resources", icon: Compass, title: "Resources", to: "/resources",
    what: "Curated external links: brokers, data sources, learning material, communities — the vetted starting points beyond this site.",
    features: ["Grouped by purpose (execution, data, learning, community)."],
    tips: [],
  },
];

// ── Recommended workflows ───────────────────────────────────────────────────
const WORKFLOWS = [
  {
    title: "The strategy pipeline (the core loop)",
    steps: [
      { text: "Learn the concept", to: "/academy", label: "Academy" },
      { text: "Study documented edges on live data", to: "/anomalies", label: "Anomalies" },
      { text: "Sanity-check the edge as numbers", to: "/lab", label: "Lab" },
      { text: "Build & backtest with fees", to: "/backtest", label: "Backtest" },
      { text: "Stress it: Monte Carlo + out-of-sample", to: "/backtest", label: "MC panel" },
      { text: "Only survivors go to the futures sim / real money", to: "/academy?c=futures-prop&l=fp-sim-phase", label: "Lesson" },
    ],
    note: "Most ideas should die in steps 2–4. That's the pipeline working, not failing.",
  },
  {
    title: "The daily session routine",
    steps: [
      { text: "Market pulse", to: "/monitor", label: "Monitor" },
      { text: "Scan for your strategy's conditions", to: "/screener", label: "Screener" },
      { text: "Mark levels & set alerts", to: "/charts", label: "Charts" },
      { text: "Size the trade before entering", to: "/tools", label: "Tools" },
      { text: "Track and journal the result", to: "/portfolio", label: "Portfolio" },
    ],
    note: "Preparation before the session, execution during, review after — never all three at once.",
  },
  {
    title: "The investor loop (slower, calmer)",
    steps: [
      { text: "Follow your universe", to: "/watchlist", label: "Watchlist" },
      { text: "Compare candidates & DCA math", to: "/compare", label: "Compare" },
      { text: "Read context, get the digest", to: "/news", label: "News" },
      { text: "Check option income structures", to: "/options", label: "Options" },
    ],
    note: "For the long-term book: fewer decisions, longer timeframes, dividends reinvested.",
  },
];

function Section({ s, open, onToggle }) {
  const Icon = s.icon;
  return (
    <div id={s.id} className="rounded-xl border border-line lg-glass overflow-hidden">
      <button onClick={onToggle} className="flex w-full items-center gap-3 p-4 text-left hover:bg-bg/40 transition-colors">
        <Icon className="w-5 h-5 text-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-text">{s.title}</p>
          <p className="text-xs text-dim truncate">{s.what}</p>
        </div>
        <ChevronDown className={cn("w-4 h-4 text-dim shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-line/50 pt-3">
          <p className="text-sm text-dim leading-relaxed">{s.what}</p>
          <div>
            <p className="text-[11px] text-dim font-medium mb-1.5">Features</p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-dim">
              {s.features.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </div>
          {s.tips.length > 0 && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 space-y-1.5">
              {s.tips.map((t, i) => (
                <p key={i} className="flex gap-2 text-sm text-text/90">
                  <Lightbulb className="w-4 h-4 text-accent shrink-0 mt-0.5" />{t}
                </p>
              ))}
            </div>
          )}
          <Link to={s.to} className="btn-accent inline-flex items-center gap-1.5 !py-1.5 text-xs">
            Open {s.title} <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}

export default function Guide() {
  const [open, setOpen] = useState(() => new Set(["backtest"]));
  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="max-w-4xl">
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Manual</p>
      <div className="flex items-center gap-2 mb-2">
        <BookOpenCheck className="w-6 h-6 text-accent" />
        <h1 className="text-xl sm:text-2xl font-bold">Guide — how to use this platform</h1>
      </div>
      <p className="text-sm text-dim mb-6 max-w-2xl">
        Everything on this site exists for one pipeline: <span className="text-text">learn a concept,
        turn it into rules, test the rules honestly, and only trade what survives.</span>{" "}
        This page explains every tool and the workflows that connect them.
      </p>

      {/* The big picture */}
      <div className="rounded-xl border border-line lg-glass p-5 mb-6">
        <p className="flex items-center gap-2 font-semibold text-text mb-2">
          <Sparkles className="w-5 h-5 text-accent" /> The platform in one paragraph
        </p>
        <p className="text-sm text-dim leading-relaxed">
          <span className="text-text">Learn</span> in the Academy →{" "}
          <span className="text-text">explore</span> markets in Monitor, Screener and Charts →{" "}
          <span className="text-text">study documented edges</span> live on the Anomalies page →{" "}
          <span className="text-text">build and test</span> strategies in the Backtest lab →{" "}
          <span className="text-text">stress-test</span> them with Monte Carlo in the Lab →{" "}
          <span className="text-text">prepare execution</span> with the Tools calculators, alerts, and the simulated
          Portfolio. Everything runs free in your browser on live market data (Binance for crypto — real-time —
          and Yahoo for stocks/ETFs). Your data (watchlist, portfolio, progress, drawings, alerts) is stored locally
          in this browser. Nothing here is investment advice; backtests are hypothetical.
        </p>
      </div>

      {/* Workflows */}
      <div className="mb-6">
        <p className="flex items-center gap-2 font-semibold text-text mb-3">
          <Route className="w-5 h-5 text-accent" /> Recommended workflows
        </p>
        <div className="grid md:grid-cols-3 gap-3">
          {WORKFLOWS.map((w) => (
            <div key={w.title} className="rounded-xl border border-line lg-glass p-4">
              <p className="text-sm font-semibold text-text mb-2">{w.title}</p>
              <ol className="space-y-1.5">
                {w.steps.map((st, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-dim">
                    <span className="font-mono text-accent shrink-0">{i + 1}.</span>
                    <span className="flex-1">
                      {st.text}{" "}
                      <Link to={st.to} className="text-accent hover:underline whitespace-nowrap">→ {st.label}</Link>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="text-[11px] text-dim/80 mt-2 leading-relaxed">{w.note}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Page reference */}
      <p className="flex items-center gap-2 font-semibold text-text mb-3">
        <BookOpenCheck className="w-5 h-5 text-accent" /> Every page, explained
      </p>
      <div className="space-y-2">
        {SECTIONS.map((s) => (
          <Section key={s.id} s={s} open={open.has(s.id)} onToggle={() => toggle(s.id)} />
        ))}
      </div>

      {/* Principles */}
      <div className="rounded-xl border border-line lg-glass p-5 mt-6">
        <p className="font-semibold text-text mb-2">The five principles behind everything here</p>
        <ul className="list-disc pl-5 space-y-1.5 text-sm text-dim">
          <li><span className="text-text">No look-ahead:</span> the backtest engine fills at the next open and brackets fill intrabar — results are honest by construction.</li>
          <li><span className="text-text">Distribution over outcome:</span> one backtest is one lucky (or unlucky) ordering. Monte Carlo shows the family it came from.</li>
          <li><span className="text-text">Costs from day one:</span> fees and slippage kill more strategies than bad ideas do.</li>
          <li><span className="text-text">Size from risk, not margin:</span> the position-size calculator and R-multiples, always.</li>
          <li><span className="text-text">Process over prediction:</span> written rules, journaled trades, and the discipline to follow a mediocre plan beat brilliant improvisation.</li>
        </ul>
      </div>
    </div>
  );
}
