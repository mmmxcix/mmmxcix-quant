// Academy content for quant.mmmxcix.com
// English educational material. Consumed by the Academy renderer.
// Block types allowed in `body`: p, h, ul, tip, formula.
//
// COURSES (bottom) is the multi-track structure: these original quant levels
// are the first course; the day-trading and options courses live in their own
// files and are imported here.

import { DAY_TRADING_COURSE } from "./academyDayTrading";
import { OPTIONS_COURSE } from "./academyOptions";
import { PROP_FIRM_COURSE } from "./academyPropFirm";

// The original four levels — the general quant learning path.
const QUANT_LEVELS = [
  {
    id: "grundlagen",
    title: "Fundamentals",
    description: "Getting started: charts, candles, timeframes, and asset classes.",
    lessons: [
      {
        id: "was-ist-ein-chart",
        title: "What is a chart?",
        minutes: 4,
        body: [
          { type: "p", text: "A chart is the graphical representation of prices over time. On the horizontal axis (X-axis), time runs from left to right; on the vertical axis (Y-axis) sits the price. Every point on the chart answers one question: what did an asset cost at a specific moment in time?" },
          { type: "p", text: "Charts make patterns visible that get lost in plain columns of numbers: trends, sideways phases, support, and resistance. They don't predict the future; they condense the past into a picture you can interpret." },
          { type: "h", text: "Common chart types" },
          { type: "ul", items: [
            "Line charts: connect only the closing prices, ideal for a rough overview.",
            "Candlestick charts (Candles): show the open, high, low, and close for each time unit.",
            "Bar charts (OHLC bars): the same information as candles, just drawn in a narrower form.",
          ] },
          { type: "p", text: "The Y-axis can be scaled linearly or logarithmically. On a linear scale, equal price distances have equal height; on a logarithmic scale, equal percentage changes do. For long time spans and large price gains, the logarithmic view is often more meaningful." },
          { type: "tip", text: "In the tool: on the Charts page you can switch between candle, line, and bar views, and use the drawing tools to draw trendlines and zones directly on the chart." },
        ],
      },
      {
        id: "kerzen-lesen-ohlc",
        title: "Reading candles (OHLC)",
        minutes: 5,
        body: [
          { type: "p", text: "A candle (candlestick) summarizes four prices for a single time unit: open, high, low, and close. These four values are abbreviated as OHLC." },
          { type: "h", text: "Anatomy of a candle" },
          { type: "diagram", id: "candle-anatomy", caption: "A bullish and a bearish candle: body from open to close, wicks to high and low." },
          { type: "ul", items: [
            "The body runs from open to close and shows where the price moved on a net basis.",
            "The wicks (shadows) above and below the body mark the high and the low.",
            "Rising candles (close above open) are usually shown in green or a light color.",
            "Falling candles (close below open) are usually shown in red or a dark color.",
          ] },
          { type: "p", text: "The shape reveals the balance of power: a long body signals a clear direction, while a small body with long wicks signals indecision. A long lower wick means buyers pushed back a sell-off; a long upper wick means the opposite." },
          { type: "p", text: "Important: a single candle is rarely meaningful on its own. Candle patterns only make sense in the context of the neighboring candles and the broader trend." },
          { type: "tip", text: "In the tool: on the Charts page, hover over a candle with your mouse to see the exact OHLC values and the date in the detail readout." },
        ],
      },
      {
        id: "zeitrahmen-verstehen",
        title: "Understanding timeframes (1m to 1M)",
        minutes: 4,
        body: [
          { type: "p", text: "The timeframe defines how much time a single candle covers. On the 1-minute chart a new candle forms every minute; on the monthly chart only once per month. The same market can look completely different across different timeframes." },
          { type: "h", text: "Typical timeframes" },
          { type: "ul", items: [
            "1m to 15m: very short-term, lots of noise, used for day trading.",
            "1h to 4h: medium-term, a good balance of detail and overview.",
            "1D (day): the standard for swing trading and investment decisions.",
            "1W to 1M (week/month): the big trend spanning years.",
          ] },
          { type: "p", text: "Smaller timeframes deliver more signals, but also more false signals (noise). Larger timeframes are slower to react but more reliable. Many market participants work with several timeframes at once: the larger one sets the direction, the smaller one the entry." },
          { type: "tip", text: "Rule of thumb: the trend on the higher timeframe takes priority. A signal against the broader trend is riskier than one in its direction." },
        ],
      },
      {
        id: "krypto-aktien-etfs",
        title: "Crypto vs. stocks vs. ETFs",
        minutes: 5,
        body: [
          { type: "p", text: "Chart analysis works the same way for all tradable assets, but the underlying asset classes differ significantly in trading hours, volatility, and risk." },
          { type: "h", text: "Stocks" },
          { type: "p", text: "A stock is a share in a company. Its value depends on earnings, outlook, and market sentiment. Stocks trade on exchanges during fixed hours, which can create price gaps to the prior day's close when the market opens in the morning." },
          { type: "h", text: "ETFs" },
          { type: "p", text: "An ETF (Exchange Traded Fund) bundles many assets together, for example an entire index like the MSCI World. This makes it broadly diversified and it usually fluctuates less than a single stock. ETFs are considered a low-cost foundation for long-term wealth building." },
          { type: "h", text: "Cryptocurrencies" },
          { type: "p", text: "Crypto assets like Bitcoin trade around the clock, seven days a week, and are usually far more volatile. There are no classic gaps, but sharp price swings are more common than with broadly diversified ETFs." },
          { type: "tip", text: "Note: this content is for educational purposes only and is not investment advice. Higher return potential always comes with higher risk." },
        ],
      },
    ],
  },
  {
    id: "indikatoren",
    title: "Indicators",
    description: "Moving averages, RSI, MACD, and Bollinger Bands.",
    lessons: [
      {
        id: "gleitende-durchschnitte",
        title: "Moving averages (SMA/EMA)",
        minutes: 5,
        body: [
          { type: "p", text: "A moving average smooths the price action by averaging over the last n periods. It filters out the noise and makes the direction of the trend visible." },
          { type: "h", text: "SMA — simple moving average" },
          { type: "p", text: "The SMA (Simple Moving Average) is the arithmetic mean of the last n closing prices. Every price counts equally." },
          { type: "formula", text: "SMA(n) = (P_1 + P_2 + ... + P_n) / n" },
          { type: "h", text: "EMA — exponential moving average" },
          { type: "p", text: "The EMA (Exponential Moving Average) weights more recent prices more heavily and therefore reacts faster. The weighting is controlled by the smoothing factor, which depends only on the period length n." },
          { type: "formula", text: "EMA_t = P_t · a + EMA_(t-1) · (1 − a),  with a = 2 / (n + 1)" },
          { type: "p", text: "When a short average crosses a long one from below to above, it's called a Golden Cross (bullish); the reverse crossing is a Death Cross (bearish). Such signals are slow and work best during strongly trending phases." },
          { type: "diagram", id: "indicator-sma-cross", caption: "Golden cross: the fast SMA crossing above the slow SMA — a bullish signal." },
          { type: "tip", text: "In the tool: on the Charts page, place SMA and EMA overlays directly over the candles; the Screener filters assets whose price is above or below the SMA (SMA trend)." },
        ],
      },
      {
        id: "rsi-momentum",
        title: "RSI — momentum & overbought/oversold",
        minutes: 5,
        body: [
          { type: "p", text: "The RSI (Relative Strength Index) measures momentum: the ratio of average price gains to average price losses over n periods (default: 14). It fluctuates between 0 and 100." },
          { type: "formula", text: "RSI = 100 − 100 / (1 + RS),  with RS = avg gain / avg loss" },
          { type: "p", text: "The averages are the mean up moves and down moves over the last n periods. When RS is large (many gains), the RSI approaches 100; when losses dominate, it falls toward 0." },
          { type: "h", text: "Interpretation" },
          { type: "diagram", id: "indicator-rsi", caption: "RSI oscillates between the 30 (oversold) and 70 (overbought) bands." },
          { type: "ul", items: [
            "RSI above 70: considered overbought, the advance may be losing steam.",
            "RSI below 30: considered oversold, a countermove is possible.",
            "Divergences: new price highs without a new RSI high point to fading momentum.",
          ] },
          { type: "p", text: "Important: in strong trends the RSI can stay overbought or oversold for a long time. A high RSI is not an automatic sell signal, but a sign of pronounced momentum." },
          { type: "tip", text: "In the tool: enable the RSI panel below the chart on the Charts page; in the Screener you can filter specifically for overbought or oversold assets." },
        ],
      },
      {
        id: "macd-trend-momentum",
        title: "MACD — trend & momentum",
        minutes: 5,
        body: [
          { type: "p", text: "The MACD (Moving Average Convergence Divergence) combines two EMAs to bundle trend direction and momentum into a single indicator. It consists of three elements: the MACD line, the signal line, and the histogram." },
          { type: "formula", text: "MACD = EMA_12 − EMA_26" },
          { type: "formula", text: "Signal = EMA_9(MACD)" },
          { type: "p", text: "The MACD line is the difference between a fast (12) and a slow (26) EMA. The signal line, in turn, is a 9-period EMA of the MACD line. The histogram shows the gap between the two: MACD minus signal." },
          { type: "diagram", id: "indicator-macd", caption: "MACD line, signal line, and histogram — the bullish signal is the MACD crossing above the signal line." },
          { type: "h", text: "Signals" },
          { type: "ul", items: [
            "MACD crosses the signal line from below to above: bullish signal.",
            "MACD crosses the signal line from above to below: bearish signal.",
            "Zero line: MACD above 0 means upward momentum, below 0 means downward momentum.",
            "A growing histogram shows increasing momentum, a shrinking one decreasing momentum.",
          ] },
          { type: "tip", text: "In the tool: display the MACD panel on the Charts page to watch line crossings and the histogram together with the price." },
        ],
      },
      {
        id: "bollinger-baender",
        title: "Bollinger Bands — volatility",
        minutes: 4,
        body: [
          { type: "p", text: "Bollinger Bands wrap a volatility band around a moving average. The middle line is an SMA (default: 20 periods); the upper and lower bands sit k standard deviations away (default: k = 2)." },
          { type: "formula", text: "Upper band = SMA(n) + k · σ" },
          { type: "formula", text: "Lower band = SMA(n) − k · σ" },
          { type: "diagram", id: "indicator-bollinger", caption: "Price rides between the volatility bands; a squeeze often precedes a big move." },
          { type: "p", text: "Here σ is the standard deviation of the last n closing prices. When volatility rises, the bands widen; when the market calms down, they contract (a squeeze). A tight squeeze often precedes a powerful move." },
          { type: "h", text: "How to read them" },
          { type: "ul", items: [
            "Prices statistically touch the bands often, without that alone being a signal.",
            "A breakout from a tight band signals rising volatility, not necessarily the direction.",
            "In trends the middle line often serves as dynamic support or resistance.",
          ] },
          { type: "tip", text: "In the tool: enable the Bollinger overlay on the Charts page to spot squeeze phases and band touches directly on the price." },
        ],
      },
    ],
  },
  {
    id: "strategien-backtesting",
    title: "Strategies & backtesting",
    description: "Test strategies, interpret metrics, and avoid pitfalls.",
    lessons: [
      {
        id: "was-ist-backtesting",
        title: "What is backtesting?",
        minutes: 5,
        body: [
          { type: "p", text: "In backtesting you apply a trading strategy to historical price data to see how it would have performed in the past. You define clear rules for entry and exit and run them over the dataset." },
          { type: "h", text: "The process" },
          { type: "ul", items: [
            "Define the rules: e.g. buy when EMA12 crosses above EMA26.",
            "Define the exit: opposite signal, stop-loss, or take-profit.",
            "Simulate over historical data and log every trade.",
            "Evaluate the result using metrics (see the next lesson).",
          ] },
          { type: "p", text: "A backtest is no substitute for judgment. It shows whether an idea has any substance at all and provides a benchmark against the simple buy-and-hold strategy (Buy & Hold). Realistic tests also account for fees and slippage." },
          { type: "tip", text: "In the tool: on the Backtest page you build Builder strategies or generate them with the AI code generator; the equity curve is plotted against Buy & Hold, and Buy/Sell markers show every trade on the chart." },
        ],
      },
      {
        id: "kennzahlen-rendite-sharpe",
        title: "Metrics: return, CAGR, Sharpe, max drawdown",
        minutes: 7,
        body: [
          { type: "p", text: "A single return figure says little. Only several metrics together reveal whether a result was solid or just random luck taken on with high risk." },
          { type: "h", text: "CAGR — annual growth rate" },
          { type: "p", text: "The CAGR (Compound Annual Growth Rate) converts the total return into a constant annual rate, making time spans of different lengths comparable." },
          { type: "formula", text: "CAGR = (Endwert / Anfangswert)^(1 / Jahre) − 1" },
          { type: "h", text: "Sharpe ratio — return per unit of risk" },
          { type: "p", text: "The Sharpe ratio relates the excess return to volatility. Annualized and with a risk-free rate of rf = 0, it simplifies to the mean of the period returns divided by their standard deviation, scaled by the square root of the number of periods per year." },
          { type: "formula", text: "Sharpe = (avg r / σ_r) · √(periods per year),  rf = 0" },
          { type: "h", text: "Maximum drawdown — largest setback" },
          { type: "p", text: "The max drawdown measures the deepest loss from a prior high (peak) to the following low (trough). It shows how painful the worst phase was." },
          { type: "formula", text: "Max Drawdown = min_t (Wert_t − Peak_t) / Peak_t" },
          { type: "h", text: "Profit factor — ratio of gains to losses" },
          { type: "p", text: "The profit factor divides the sum of all gains by the sum of all losses. A value above 1 means the strategy brought in more than it lost on balance." },
          { type: "formula", text: "Profit-Faktor = Σ Bruttogewinne / |Σ Bruttoverluste|" },
          { type: "tip", text: "In the tool: the Backtest page reports CAGR, Sharpe, max drawdown, and profit factor for every run, so you measure strategies not only by return but by risk." },
        ],
      },
      {
        id: "overfitting",
        title: "Overfitting & why backtests can lie",
        minutes: 6,
        body: [
          { type: "p", text: "A backtest always describes the past only. If you keep optimizing the rules until they fit the historical data exactly, you get overfitting: the strategy is perfectly tuned to the noise of the past and fails on new data." },
          { type: "h", text: "Common traps" },
          { type: "ul", items: [
            "Too many parameters fine-tuned to a single time period.",
            "Lookahead bias: accidentally using information that wasn't available at the time.",
            "Survivorship bias: only assets that still exist today are tested, while failures are missing.",
            "Ignored costs: without fees and slippage, every strategy looks too good.",
          ] },
          { type: "p", text: "The remedies are simple rules with few parameters, testing across several market phases, and splitting into training and test data (out-of-sample). If a strategy only works with exactly one parameter combination, that's a warning sign." },
          { type: "tip", text: "Rule of thumb: the more knobs you turn until the backtest shines, the less it's worth. Robustness beats perfection." },
        ],
      },
      {
        id: "trendfolge-mean-reversion",
        title: "Trend-following vs. mean reversion",
        minutes: 5,
        body: [
          { type: "p", text: "Almost every strategy belongs to one of two basic families. They rest on opposite assumptions about how prices behave." },
          { type: "h", text: "Trend-following" },
          { type: "p", text: "Trend-following assumes that a move already underway will continue: what rises keeps rising. It buys strength and sells weakness, typically using moving averages or breakouts. Trend-followers have many small losses and a few big winners." },
          { type: "diagram", id: "pattern-trend-structure", caption: "What a trend actually is: higher highs and higher lows going up, lower highs and lower lows going down." },
          { type: "h", text: "Mean reversion" },
          { type: "p", text: "Mean reversion assumes that prices return to an average: excesses correct themselves. It buys weakness and sells strength, often using RSI or Bollinger Bands. Many small winners are offset by a few, but painful, losses." },
          { type: "ul", items: [
            "Trend-following works well in clearly directional markets and suffers in sideways phases.",
            "Mean reversion works well in sideways phases and suffers in strong trends.",
          ] },
          { type: "tip", text: "In the tool: both approaches can be rebuilt as Builder strategies on the Backtest page and compared across different market phases." },
        ],
      },
    ],
  },
  {
    id: "risiko-psychologie",
    title: "Risk & psychology",
    description: "Position size, risk/reward, stops, and common cognitive biases.",
    lessons: [
      {
        id: "positionsgroesse-1-prozent",
        title: "Position size & the 1% risk rule",
        minutes: 5,
        body: [
          { type: "p", text: "The most important decision is not what you buy, but how much. The position size determines how hard a single losing trade hits your total capital. The goal is to keep every single loss small and bearable." },
          { type: "h", text: "The 1% rule" },
          { type: "p", text: "A widely used rule says to risk at most about 1% of your total capital per trade. If you risk 1%, it takes many losses in a row to do serious damage. The number of shares follows from the risk per trade and the distance to the stop-loss." },
          { type: "formula", text: "Position size = (capital · risk%) / (entry − stop-loss)" },
          { type: "p", text: "Example: with 10,000 in capital and 1% risk, a trade may lose at most 100. If the stop sits 2 below the entry, that works out to 50 shares. That way the loss is always capped at the same amount, regardless of the asset." },
          { type: "tip", text: "In the tool: use the Position size calculator on the Tools page to automatically get the right number of shares from your capital, risk percentage, and stop distance." },
        ],
      },
      {
        id: "crv-break-even-winrate",
        title: "Risk/Reward (R:R) & break-even win rate",
        minutes: 5,
        body: [
          { type: "p", text: "The Risk/Reward ratio (R:R) relates the potential gain to the risked loss of a trade. It answers the question: how much can I win, measured against what I'm risking?" },
          { type: "formula", text: "R:R = (take-profit − entry) / (entry − stop-loss)" },
          { type: "diagram", id: "trade-bracket", caption: "A 2:1 trade fully specified before entry: the target sits two risk-units (+2R) above entry, the stop one (−1R) below." },
          { type: "p", text: "An R:R of 3 means the targeted gain is three times as large as the risk. The higher the R:R, the less often you need to be right to be profitable." },
          { type: "h", text: "Break-even win rate" },
          { type: "p", text: "From the R:R follows the minimum hit rate at which a strategy becomes cost-neutral. Below it the strategy loses money, above it it makes money." },
          { type: "formula", text: "Break-even win rate = 1 / (1 + R:R)" },
          { type: "p", text: "With an R:R of 2, the break-even win rate is about 33%: you can lose two out of three trades and still be at zero. This shows why a good R:R can matter more than a high hit rate." },
          { type: "tip", text: "In the tool: the R:R calculator on the Tools page gives you the ratio and the required hit rate directly from your entry, stop, and target." },
        ],
      },
      {
        id: "stop-loss-take-profit",
        title: "Stop-loss & take-profit",
        minutes: 5,
        body: [
          { type: "p", text: "A stop-loss is a predefined exit threshold that limits a loss when the market moves against your position. A take-profit, conversely, sets the target at which gains are realized. Ideally both are defined before entering, not in the heat of the moment." },
          { type: "h", text: "Where to place the stop?" },
          { type: "ul", items: [
            "Technical: below a support level or the most recent relevant low.",
            "Volatility-based: as a multiple of the ATR (Average True Range), so the stop fits the normal fluctuation.",
            "Not too tight: a stop set within the noise gets triggered by random moves.",
          ] },
          { type: "diagram", id: "stop-trailing", caption: "A trailing stop steps up under each higher low, locking in gains until the trend finally breaks." },
          { type: "p", text: "A trailing stop follows the price up as it rises, locking in ongoing gains without rigidly capping the target. What matters is consistency: a stop only helps if you leave it in place instead of moving it lower as the position falls into a loss." },
          { type: "tip", text: "In the tool: the ATR stops calculator on the Tools page suggests volatility-appropriate stop distances; Price alerts on the Charts page warn you when a threshold is reached." },
        ],
      },
      {
        id: "haeufige-denkfehler-bias",
        title: "Common cognitive biases",
        minutes: 6,
        body: [
          { type: "p", text: "The biggest source of error rarely sits in the chart, but in your head. Systematic cognitive biases cause even good rules to go unfollowed." },
          { type: "h", text: "Widespread biases" },
          { type: "ul", items: [
            "Confirmation bias: you only look for information that supports your own opinion.",
            "Loss aversion: losses hurt more than equally sized gains please, so you let losers run too long.",
            "Recency bias: the most recent experience is overweighted and projected into the future.",
            "Overconfidence: after a few wins you overestimate your own hit rate and increase your risk.",
            "Sunk-cost fallacy: holding on to a losing position simply because you've already invested so much.",
          ] },
          { type: "p", text: "The most effective remedy is a written plan, set before entering, with clear rules for entry, position size, and exit. A trading journal makes recurring mistakes visible. Following a mediocre plan with discipline often beats constantly second-guessing yourself on gut feeling." },
          { type: "tip", text: "Note: all content in this Academy is for educational purposes and does not constitute investment advice. Use the simulated Portfolio feature to practice strategies risk-free before real money is on the line." },
        ],
      },
    ],
  },
];

// Multi-course structure consumed by the Academy page. Each course has an id,
// title, description, and ordered levels (each with lessons). Lesson ids are
// globally unique across all courses so progress tracking stays simple.
export const COURSES = [
  {
    id: "quant-foundations",
    title: "Quant Foundations",
    description: "The core path: charts, indicators, backtesting and risk — beginner to self-sufficient.",
    levels: QUANT_LEVELS,
  },
  DAY_TRADING_COURSE,
  PROP_FIRM_COURSE,
  OPTIONS_COURSE,
];

// Back-compat: the flat level list of the first course.
export const ACADEMY = QUANT_LEVELS;
