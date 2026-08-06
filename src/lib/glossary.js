// Plain-language definitions for the metric shorthand scattered across Argus,
// Cortex and the Registry. One source of truth so a term reads the same
// everywhere — surfaced via <Abbr t="PF" /> (see components/Abbr.jsx).
//
// Keep each entry to one sentence a newcomer can parse: what it is, then why it
// matters. No jargon inside the definition of a jargon term.
export const GLOSSARY = {
  PF: "Profit Factor — gross profit ÷ gross loss. Above 1 means the winners outweigh the losers; 1.5+ is healthy.",
  DD: "Drawdown — the drop from an equity peak to the following trough. Smaller is better.",
  "Max drawdown": "The largest peak-to-trough equity decline over the whole run — the worst loss you'd have had to sit through.",
  R: "R-multiple — profit or loss measured in units of the trade's initial risk. +2R means it made twice what it risked.",
  Expectancy: "The average R-multiple per trade — the edge. Positive over a real sample means the system makes money.",
  "Win rate": "Share of trades that closed green. A high win rate alone doesn't mean profit — a few big losers can still sink it.",
  Exposure: "How much of the book is committed to open positions right now, versus sitting in cash.",
  Size: "Position size — how large a single trade is allowed to be, after the risk limits are applied.",
  Sharpe: "Sharpe ratio — return per unit of volatility. Higher means a smoother ride for the same return.",
  Sortino: "Like Sharpe, but only penalises downside volatility — upside swings don't count against it.",
  "Deflated Sharpe": "Sharpe adjusted for how many strategies were tried, so a good number found by luck doesn't fool you.",
  RiskGate: "The safety layer that caps position size, total exposure and drawdown before any order can go live.",
  Regime: "The market state (Bull / Bear / Neutral) inferred by a Hidden Markov Model from recent price behaviour.",
  Edge: "The repeatable inefficiency a strategy exploits — the reason it should make money rather than break even.",
  CAGR: "Compound Annual Growth Rate — the smoothed yearly return that takes you from start to end equity.",
  IC: "Information Coefficient — how well a signal's forecast lines up with the actual next-period return. Higher is more predictive.",
  Slippage: "The gap between the price you expected and the price you actually got — real-world execution cost.",
  Turnover: "How often the book is traded over a period. High turnover means costs eat more of the return.",
  // Argus risk-check chips
  Vol: "Volatility check — the position is sized down, or blocked, when recent price swings are abnormally large.",
  MaxLoss: "Max-loss check — the trade's worst-case loss has to stay within the per-trade risk budget.",
};

// The visible label for a term, when it differs from its glossary key.
export const GLOSSARY_LABEL = {
  "Deflated Sharpe": "Deflated Sharpe",
};
