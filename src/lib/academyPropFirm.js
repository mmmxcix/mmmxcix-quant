// academyPropFirm.js — "Futures & Prop-Firm Trading" course.
// The bridge from strategy ideas to actually trading funded capital: futures
// mechanics, prop-firm rules and economics, honest strategy validation, and
// the execution path from simulator to funded account to your own broker.
// Same shape as the other courses (levels → lessons → body blocks).

export const PROP_FIRM_COURSE = {
  id: "futures-prop",
  title: "Futures & Prop-Firm Trading",
  description:
    "The funded-trader path: futures mechanics, prop-firm rules, strategy validation, and the road from simulator to funded account.",
  levels: [
    // ── Level 1: Futures foundations ────────────────────────────────────────
    {
      id: "fp-futures",
      title: "Futures Foundations",
      description: "What futures are and how NQ/MNQ actually work: ticks, margin, sessions.",
      lessons: [
        {
          id: "fp-what-are-futures",
          title: "What are futures?",
          minutes: 6,
          body: [
            { type: "p", text: "A futures contract is a standardized agreement to buy or sell something at a fixed price on a future date. Index futures like the NQ (Nasdaq-100) settle in cash — nobody delivers 100 tech stocks; the difference between your entry and exit price is simply paid out in dollars." },
            { type: "p", text: "For a trader, futures behave like a highly liquid, leveraged bet on the index price. You can go long or short with equal ease, there is no borrow fee for shorting, and gains and losses settle daily." },
            { type: "h", text: "Why day traders love index futures" },
            { type: "ul", items: [
              "Nearly 23-hour trading (Globex), with deep liquidity in US hours.",
              "Long and short are symmetric — no short-sale restrictions.",
              "One instrument instead of scanning hundreds of stocks.",
              "Favorable tax treatment in some jurisdictions and no pattern-day-trader rule.",
              "Central clearing: your counterparty is the exchange, not another trader.",
            ] },
            { type: "h", text: "Expiry and rollover" },
            { type: "p", text: "Index futures expire quarterly (March, June, September, December). Traders don't hold to expiry — they \"roll\" to the next contract about a week before, when volume migrates. Continuous charts stitch contracts together; be aware backtests over years span many contracts." },
            { type: "tip", text: "Futures are a zero-sum game plus costs: every dollar you win, someone else loses. Your edge must be real — there is no long-term drift working for you like in buy-and-hold stock investing." },
          ],
        },
        {
          id: "fp-contract-specs",
          title: "NQ & MNQ: ticks, points, contract math",
          minutes: 7,
          body: [
            { type: "p", text: "Every futures contract has fixed specifications. You must know them cold, because they translate chart distance directly into money." },
            { type: "h", text: "The Nasdaq-100 contracts" },
            { type: "ul", items: [
              "NQ (E-mini Nasdaq-100): $20 per index point, tick size 0.25 points = $5 per tick.",
              "MNQ (Micro E-mini): exactly 1/10th of NQ — $2 per point, $0.50 per tick.",
              "ES (E-mini S&P 500): $50 per point; MES (Micro): $5 per point.",
            ] },
            { type: "formula", text: "P/L = (exit − entry) points × $/point × contracts\nExample: MNQ long +50 points × $2 × 2 contracts = +$200" },
            { type: "h", text: "What a normal day looks like" },
            { type: "p", text: "The NQ commonly moves 150–400 points in a single session. On one NQ contract that is $3,000–$8,000 of range; on one MNQ it is $300–$800. This is why account rules (next level) make full-size NQ contracts unusable for small funded accounts — the daily noise alone exceeds the loss limits." },
            { type: "h", text: "Commissions and slippage" },
            { type: "p", text: "A realistic all-in round-turn cost for MNQ (commission + exchange fees + typical 1-tick slippage) is roughly $1.50–$3.50 per contract. That sounds tiny, but a strategy trading once a day, 250 days a year, pays ~$500–900 per contract per year — many marginal strategies die on costs alone." },
            { type: "tip", text: "Always backtest with realistic costs. A strategy that only works at zero commission does not work." },
          ],
        },
        {
          id: "fp-margin-leverage",
          title: "Margin, leverage & liquidation risk",
          minutes: 6,
          body: [
            { type: "p", text: "Futures margin is not a down payment — it is a performance bond. To hold one MNQ (notional value ≈ $2 × index ≈ $40,000+) the exchange requires only a few hundred to ~$2,000 of margin depending on the broker. That is built-in leverage of 20x or more." },
            { type: "h", text: "Two kinds of margin" },
            { type: "ul", items: [
              "Intraday margin: what your broker requires while the position is open during the day — often very low ($50–$500 per micro).",
              "Overnight (exchange/initial) margin: much higher; holding through the close requires the full exchange margin.",
            ] },
            { type: "h", text: "Leverage cuts both ways" },
            { type: "p", text: "Low margin lets a $2,000 account technically hold several micros — and lose the whole account on one bad afternoon. Leverage does not create edge; it only scales your P/L (and your mistakes). Position size should come from your risk per trade, never from what margin allows." },
            { type: "formula", text: "Contracts = risk budget per trade / (stop distance in points × $/point)\nExample: $150 risk, 30-point stop on MNQ → 150 / (30 × 2) = 2.5 → trade 2 contracts" },
            { type: "tip", text: "Decide contracts from your stop, not from your margin. If the formula says 0 contracts, the trade is too big for your account — skip it, don't shrink the stop artificially." },
          ],
        },
        {
          id: "fp-sessions-liquidity",
          title: "Sessions: Globex, RTH & the NY open",
          minutes: 6,
          body: [
            { type: "p", text: "Index futures trade almost around the clock, but not all hours are equal. Understanding the session structure is essential for intraday strategies — most of them (including opening-range breakouts) are defined relative to specific session times." },
            { type: "h", text: "The structure of a futures day (US index futures)" },
            { type: "ul", items: [
              "Globex / overnight: Sunday evening to Friday, nearly 23h/day. Thin volume, driven by Asia/Europe and news.",
              "Regular Trading Hours (RTH): 9:30–16:00 New York time — where most volume and the big moves happen.",
              "The open (9:30–10:30 NY): highest volatility and volume of the day; opening-range strategies live here.",
              "Lunch (12:00–13:30 NY): volume dries up, ranges get choppy.",
              "The close (15:00–16:00 NY): second volume peak, rebalancing flows.",
            ] },
            { type: "h", text: "Time zones will bite you" },
            { type: "p", text: "New York switches between EST (UTC−5) and EDT (UTC−4). A strategy coded as \"9:30 NY open\" must handle daylight saving. In this site's backtester, ctx.session times are UTC — the NY open is 14:30 UTC in summer and 15:30 UTC in winter. From Switzerland, the NY open is 15:30 local time. Getting this wrong silently ruins an intraday backtest." },
            { type: "tip", text: "In the tool: the Tools page has a market-hours clock. When you code session strategies in the Backtest editor, ctx.session.minuteOfDay is UTC — convert deliberately." },
          ],
        },
      ],
    },

    // ── Level 2: Prop firms ────────────────────────────────────────────────
    {
      id: "fp-propfirms",
      title: "Prop Firms",
      description: "How funded accounts really work: rules, economics, and how not to get burned.",
      lessons: [
        {
          id: "fp-how-propfirms-work",
          title: "How prop firms make money (and why that matters)",
          minutes: 6,
          body: [
            { type: "p", text: "A futures prop firm sells you an evaluation (\"combine\", \"challenge\"): you trade a simulated account under strict rules for a monthly fee. Pass, and you get a \"funded\" account where the firm keeps a share of profits (often 10–20% after a first fully-yours chunk) and pays out the rest." },
            { type: "h", text: "The honest economics" },
            { type: "p", text: "Most participants fail evaluations, and evaluation fees — not trading profits — are the core revenue of most firms. That doesn't make them scams: think of it as paying a defined, capped fee for the right to trade meaningful size without risking your own capital. Your worst case is the subscription fee, never a blown $50,000." },
            { type: "ul", items: [
              "You risk: the monthly evaluation fee (and an activation fee if you pass).",
              "You gain: access to size, real payout potential, and a forced framework of discipline.",
              "The firm gains: fees from the many who fail, a profit share from the few who succeed.",
            ] },
            { type: "h", text: "What this means for your approach" },
            { type: "p", text: "Treat evaluations as tuition with a defined cost, and only start paying it once your strategy has already proven itself in a free simulator. Paying monthly fees while still figuring out your strategy is the most common and most avoidable money leak." },
            { type: "tip", text: "Never buy an evaluation on impulse or during a losing streak. The reset button is their business model." },
          ],
        },
        {
          id: "fp-rules-drawdown",
          title: "The rules: trailing drawdown, daily loss, consistency",
          minutes: 8,
          body: [
            { type: "p", text: "Prop-firm rules are stricter than any broker's. They are designed to filter out gamblers — and they will also filter out good strategies traded at the wrong size. You must design your trading around the rules, not hope to squeeze past them." },
            { type: "h", text: "The rules that end accounts" },
            { type: "ul", items: [
              "Maximum Loss Limit (trailing drawdown): e.g. $2,000 on a 50K account. Crucially it often TRAILS your equity peak — including unrealized highs. Make $1,500, give it back, and you can fail while 'up' on the day.",
              "Daily Loss Limit: e.g. $1,000 — one bad morning can end the evaluation even if the monthly picture is fine.",
              "Profit target: e.g. $3,000 on a 50K combine to pass.",
              "Consistency rules: e.g. no single day may be more than 50% of total profit — you can't pass on one lucky trade.",
              "Position limits and no trading through major news releases (firm-specific).",
            ] },
            { type: "h", text: "The math nobody does" },
            { type: "p", text: "A 50K account with a $2,000 trailing drawdown is NOT a $50,000 account — it is a $2,000 risk budget with $50,000 of buying power. Any strategy whose normal historical drawdown exceeds ~$1,500 at your chosen size will eventually fail the account by pure statistics, even if it is genuinely profitable long-term." },
            { type: "formula", text: "Survivable size ≈ (max loss limit × 0.6) / historical max drawdown per contract\nExample: $2,000 limit, ORB drawdown ≈ $800 per MNQ → 2000×0.6/800 ≈ 1–2 micros" },
            { type: "tip", text: "Size for the drawdown limit, not the profit target. Passing slowly is winning; failing fast is the default outcome." },
          ],
        },
        {
          id: "fp-account-size-micros",
          title: "Choosing account size & why micros are mandatory",
          minutes: 6,
          body: [
            { type: "p", text: "Bigger accounts sound better but scale the fees, not your edge. The right choice is the smallest account whose loss limits comfortably contain your strategy's historical drawdown at minimum size." },
            { type: "h", text: "Typical 50K combine (the usual starting point)" },
            { type: "ul", items: [
              "~$50/month evaluation fee (discounts are frequent and worth waiting for).",
              "≈$2,000 trailing max loss, ≈$1,000 daily loss, ≈$3,000 profit target.",
              "Allows several contracts — permission you should NOT use at the start.",
            ] },
            { type: "h", text: "Why full-size NQ is off the table" },
            { type: "p", text: "Validated NQ intraday strategies routinely show historical drawdowns of thousands of dollars per full contract — an order of magnitude above a 50K account's loss limit. One normal losing streak destroys the account. With 1–2 MNQ (1/10th size) the same strategy's drawdown fits inside the rules with room to breathe." },
            { type: "p", text: "The practical plan: pass the evaluation with 1–2 micros, stay at 1–2 micros in the funded account until you have a payout buffer above the drawdown floor, and only then scale by single micros. Scaling before you have buffer is how funded accounts die in week one." },
            { type: "tip", text: "Your first goal in a funded account is not profit — it is building enough cushion that the trailing drawdown can no longer reach you on a normal losing streak." },
          ],
        },
        {
          id: "fp-automation-rules",
          title: "Automation rules: what firms allow (read this twice)",
          minutes: 6,
          body: [
            { type: "p", text: "If your plan involves AI-built strategies, this is the lesson that keeps you out of trouble. Most reputable futures prop firms distinguish between semi-automation and full automation — and the difference decides whether you keep your account." },
            { type: "h", text: "The typical policy" },
            { type: "ul", items: [
              "Allowed: manual trading based on algorithmic signals; semi-automated tools (bracket orders, one-click entries) while YOU are present and supervising.",
              "Grey zone: strategy executes automatically while you sit in front of it, able to intervene — some firms allow this explicitly, others don't.",
              "Forbidden almost everywhere: fully unattended bots, running the same algo across many accounts, high-frequency approaches, exploiting sim-fill quirks.",
            ] },
            { type: "h", text: "Why the penalty is severe" },
            { type: "p", text: "Violations are typically punished with account closure and forfeiture of profits — after you did the hard part of being profitable. Rules also differ between evaluation and funded stages and change over time, so read the current rulebook of your specific firm before connecting anything automated, and ask their support in writing if unsure." },
            { type: "p", text: "The realistic starting model: your strategy computes signals (in this tool, TradingView, or NinjaTrader), and you execute them manually with predefined bracket orders. You are the executor of a mechanical system — this is allowed everywhere, and it trains exactly the discipline that automation would otherwise hide." },
            { type: "tip", text: "\"Semi-automated with you at the screen\" is the safe default. Full automation is a later decision to make deliberately, with written confirmation from the firm." },
          ],
        },
        {
          id: "fp-costs-timeline",
          title: "Costs & a realistic timeline",
          minutes: 5,
          body: [
            { type: "p", text: "Budget the whole journey before starting, so a normal amount of failure doesn't surprise you into quitting or tilting." },
            { type: "h", text: "Monthly costs by phase" },
            { type: "ul", items: [
              "Learning & simulator (2–6 months): $0–15/month — free platforms and this site cover everything.",
              "Evaluation (1–4 months, realistically with failed attempts): ~$50/month, often discounted.",
              "Funded: one-time activation (~$150), then exchange data fees (~$30–60/month), no more evaluation fee.",
              "Optional later: TradingView plan (~$15) or execution bridge (~$25) if and when allowed/needed.",
            ] },
            { type: "h", text: "A realistic timeline" },
            { type: "p", text: "Expect 6–12 months from first lesson to first funded payout — and treat that as the good scenario. Anyone promising faster is selling something. Failed evaluations are normal data points, not verdicts; what matters is that each attempt runs the SAME validated strategy, so a failure teaches you about variance or sizing rather than about your discipline." },
            { type: "formula", text: "Total realistic budget to funded: ≈ $150–400 in fees over 6–12 months\n(compare: one impulsive full-NQ trade can lose more in 10 minutes)" },
            { type: "tip", text: "Set a hard budget (e.g. $400) and a rule: if it's spent without passing, you go back to the simulator for 3 months instead of buying another reset. Decide this now, while calm." },
          ],
        },
      ],
    },

    // ── Level 3: Strategy & validation ─────────────────────────────────────
    {
      id: "fp-validation",
      title: "Strategy & Validation",
      description: "Building intraday edges and — the hard part — proving they are real.",
      lessons: [
        {
          id: "fp-orb-anatomy",
          title: "Anatomy of an Opening Range Breakout",
          minutes: 7,
          body: [
            { type: "p", text: "The Opening Range Breakout (ORB) is the classic intraday futures strategy and a perfect study object: simple enough to understand completely, rich enough to teach every concept — sessions, brackets, R-multiples, and validation." },
            { type: "diagram", id: "pattern-breakout", caption: "The core idea: a defined range, then trading the break of it." },
            { type: "h", text: "The recipe" },
            { type: "ul", items: [
              "1. Define the opening range: high and low of the first N minutes after the session open (e.g. 30 minutes after 9:30 NY).",
              "2. Entry: buy a break above the range high (or short a break below the low).",
              "3. Stop: the opposite side of the range — if price traverses the whole range against you, the idea is dead.",
              "4. Target: a multiple of the range width (1R is common), or time-based exit before the close.",
              "5. One trade per day. Flat by session end — no overnight risk.",
            ] },
            { type: "h", text: "Why it can work (and when it doesn't)" },
            { type: "p", text: "The open concentrates overnight news, institutional orders, and the day's positioning into one auction. A decisive break of that auction's range sometimes continues as latecomers chase. But in ranging, news-free markets the breakout fails often — ORB variants live or die on filters (trend, volatility, day-of-week) and on cost discipline, not on the entry itself." },
            { type: "tip", text: "In the tool: the Backtest page has ORB both as a Builder preset (with range bars, target R, stop buffer) and as a code example — run it on 5m data and study WHERE it loses, not just the total return." },
          ],
        },
        {
          id: "fp-building-intraday",
          title: "Building intraday strategies in the Backtest lab",
          minutes: 7,
          body: [
            { type: "p", text: "This site's backtest engine supports the full intraday toolkit: long and short positions, live stop/target bracket orders checked inside each bar, and session context for time-of-day logic. Here is how the pieces map to concepts." },
            { type: "h", text: "The engine contract" },
            { type: "ul", items: [
              "Your strategy(ctx) runs once per closed bar; plain returns (\"long\"/\"short\"/\"flat\") execute at the next bar's open.",
              "Bracket returns — { signal, stop, target } — place live exit orders: they fill intrabar the moment price touches them, stop first if both are hit in one bar (conservative).",
              "ctx.session gives UTC hour/minute and isNewDay — the building blocks for opening ranges and end-of-day flattening.",
              "Top-level variables persist across bars: accumulate the range, remember 'traded today', track your trailing stop.",
            ] },
            { type: "h", text: "Data honesty" },
            { type: "p", text: "The tool has crypto (Binance) and stocks/ETFs (Yahoo) — not CME futures, and no order-flow data. Use it to learn strategy construction and validation mechanics on liquid symbols (BTCUSDT 5m, QQQ 5m as an NQ proxy). The final futures backtest must then run on real NQ/MNQ data in a futures platform — same logic, real market." },
            { type: "p", text: "This two-step approach is a feature, not a compromise: if your strategy's logic only works on one specific instrument's quirks, that itself is a warning sign." },
            { type: "tip", text: "Workflow: prototype and validate the LOGIC here, where iteration is instant — then port the survivor to NinjaTrader/TradingView for futures-data confirmation. Never skip the second step before paying for an evaluation." },
          ],
        },
        {
          id: "fp-overfitting-ai",
          title: "Overfitting: why AI-generated strategies fail",
          minutes: 8,
          body: [
            { type: "p", text: "This is the most important lesson in the course. Overfitting means your strategy has memorized the past instead of learning a repeatable pattern. It is THE default failure mode of backtesting — and AI assistance makes it easier, not harder, to fall into." },
            { type: "h", text: "Why AI amplifies the risk" },
            { type: "p", text: "An AI will happily generate twenty strategy variants in an hour. Test twenty variants on the same data and pick the best, and you have effectively fit one strategy with the combined parameters of all twenty — the winner won partly by luck. The more you search, the more impressive the best backtest looks, and the less it means. This is called selection bias or data mining; it feels like research and works like self-deception." },
            { type: "h", text: "The warning signs" },
            { type: "ul", items: [
              "Many parameters, precisely tuned (why 47-period SMA and not 45?).",
              "Performance collapses when a parameter moves slightly — a real edge is a plateau, not a needle.",
              "Spectacular equity curve with few trades (< ~100 trades = statistics of a coin flip streak).",
              "It only works on one symbol and one timeframe.",
              "You tweaked it after seeing the results, more than twice.",
            ] },
            { type: "h", text: "The defenses" },
            { type: "ul", items: [
              "Out-of-sample: fit on one period, judge ONLY on data the strategy has never seen — and look at that result once.",
              "Fewer knobs: every parameter is a degree of freedom to fool yourself with. ORB has ~3; that's a good number.",
              "Parameter plateaus: test neighboring values; accept only strategies that survive their whole neighborhood.",
              "Count your attempts: if the 14th variant finally 'works', it probably doesn't.",
              "An economic WHY: who is on the other side of your trade and why are they systematically wrong?",
            ] },
            { type: "tip", text: "Rule for AI use: let the AI write the code, but YOU fix the hypothesis before generating, and never let backtest results steer what you generate next without counting those iterations as search." },
          ],
        },
        {
          id: "fp-validation-toolkit",
          title: "The validation toolkit: OOS, walk-forward, Monte Carlo",
          minutes: 8,
          body: [
            { type: "p", text: "Professional strategy reports don't just show an equity curve — they attack it. Before trusting any strategy with evaluation fees, run it through this gauntlet. Each test asks a different way of saying 'was this luck?'." },
            { type: "h", text: "1. Out-of-sample (OOS) split" },
            { type: "p", text: "Develop on e.g. 2019–2023, then run once on 2024–2025. If performance roughly holds (say, ≥50% of in-sample expectancy), the edge generalizes. If it collapses, you fitted noise — go back, and get NEW out-of-sample data before judging again." },
            { type: "h", text: "2. Walk-forward analysis" },
            { type: "p", text: "Repeat the OOS idea in rolling windows: optimize on window 1, test on window 2; slide forward; stitch together only the test segments. The stitched curve is the honest estimate of live performance, because every trade in it was made on unseen data." },
            { type: "h", text: "3. Monte Carlo / bootstrap on the trade list" },
            { type: "p", text: "Take your backtest's individual trade results and reshuffle/resample them thousands of times. This answers two critical questions: what is the probability the strategy's edge is actually ≤ 0 (should be well under 5%), and what drawdowns can this SAME strategy produce by unlucky ordering? The Monte Carlo drawdown distribution — not the single backtest drawdown — is what you compare against a prop firm's loss limit." },
            { type: "formula", text: "Judge a strategy by:  P(edge ≤ 0) from bootstrap  +  95th-percentile MC drawdown vs. loss limit\n— not by the backtest's total return." },
            { type: "p", text: "A permutation test adds one more attack: run the strategy on shuffled/randomized price data — it should NOT make money there. If it does, your engine or logic has a bug (usually look-ahead)." },
            { type: "tip", text: "In the tool: every backtest result now includes a Monte Carlo panel that bootstraps its trades, and the Lab page lets you simulate any edge (win rate + R + risk) against a prop-firm loss limit before you ever code it." },
            { type: "tip", text: "Remember the Fabio-report lesson: even a beautiful validation of a trade log cannot detect look-ahead bugs in the strategy that produced the log. Validate the code path, not just the results." },
          ],
        },
        {
          id: "fp-expectancy-r",
          title: "Expectancy, R-multiples & cost reality",
          minutes: 6,
          body: [
            { type: "p", text: "Professionals don't think in dollars or win rate — they think in R, where 1R is the amount risked per trade (entry to stop). This normalizes every trade and makes strategies comparable." },
            { type: "formula", text: "Expectancy per trade = (win% × avg win in R) − (loss% × avg loss in R)\nExample ORB: 45% × 1R − 55% × 1R = −0.10R… until winners average 1.3R → +0.135R" },
            { type: "h", text: "What the numbers mean" },
            { type: "ul", items: [
              "Expectancy +0.1R to +0.3R per trade is a GOOD intraday system — this is what real edges look like.",
              "With $150 risk per trade and +0.15R expectancy, 20 trades/month ≈ $450/month per unit of risk. Modest, scalable, real.",
              "Win rate alone is meaningless: 90% win rate with 0.2R wins and 1R losses loses money.",
            ] },
            { type: "h", text: "Costs eat small edges" },
            { type: "p", text: "Commissions and slippage are charged in dollars but must be converted to R. With a 30-point MNQ stop ($60 risk), $3 round-turn cost is 0.05R per trade — that alone removes a third of a +0.15R edge. This is why tight-stop, high-frequency intraday systems are so much harder than they look, and why every backtest must include costs from day one." },
            { type: "tip", text: "When comparing strategy variants, compare expectancy in R after costs and the trade count — never the total return, which mostly reflects position sizing." },
          ],
        },
      ],
    },

    // ── Level 4: Execution path ────────────────────────────────────────────
    {
      id: "fp-execution",
      title: "The Execution Path",
      description: "Simulator, evaluation, funded, and eventually your own account — with go/no-go gates.",
      lessons: [
        {
          id: "fp-sim-phase",
          title: "The simulator phase (and its exit criteria)",
          minutes: 7,
          body: [
            { type: "p", text: "Between 'my backtest looks good' and 'I pay for an evaluation' stands the simulator phase: trading your exact strategy on live futures data with fake money. It tests everything the backtest cannot — your execution, latency, real fills, and your nerves." },
            { type: "h", text: "Free tools that suffice completely" },
            { type: "ul", items: [
              "NinjaTrader: free for sim trading and backtesting, real futures data, industry standard around Topstep-style firms.",
              "TradingView paper trading: fastest to start, Pine Script strategies, delayed futures data on the free plan.",
              "This site's backtest lab: for iterating on logic before it ever reaches the sim.",
            ] },
            { type: "h", text: "How to sim so it actually counts" },
            { type: "ul", items: [
              "Trade the exact written rules — entry, stop, target, times, size. Every deviation is logged as an error, regardless of P/L.",
              "Simulate the prop-firm rules too: apply the trailing drawdown and daily loss limit to your sim account.",
              "Trade the session you will really trade (for the NY open from Europe: 15:30–17:30 local — check this fits your life!).",
              "Journal every trade: screenshot, planned vs. actual, rule violations.",
            ] },
            { type: "h", text: "Exit criteria (the go/no-go gate)" },
            { type: "p", text: "Move to a paid evaluation only when, over at least 2–3 months and ~40+ trades: your sim expectancy is positive after costs, your max drawdown stayed under ~60% of the prop firm's limit at your size, and your rule-violation rate is near zero. If any of these fail, the simulator just saved you months of fees — that is the system working." },
            { type: "tip", text: "The sim phase feels like a delay. It isn't — it is the cheapest place you will ever discover problems. Every issue found here costs $0; the same issue in an evaluation costs a reset, and in a funded account a payout." },
          ],
        },
        {
          id: "fp-eval-playbook",
          title: "The evaluation playbook",
          minutes: 6,
          body: [
            { type: "p", text: "An evaluation is not a trading contest — it is a rule-compliance test with a profit condition attached. The traders who pass are rarely the boldest; they are the ones who made the drawdown limit unreachable." },
            { type: "h", text: "The playbook" },
            { type: "ul", items: [
              "Trade the identical strategy and size from your sim phase. The evaluation changes nothing except that the fee is real.",
              "Size so a normal losing streak (5–7 losses) uses at most half the trailing drawdown.",
              "No 'target pressure': there is usually no time limit worth risking for. Slow is fine; blown is final.",
              "Stop for the day after 2 losses or when down ~50% of the daily limit — never trade back a daily hole.",
              "Respect consistency rules from day one: several medium days beat one hero day that violates the profit-distribution rule.",
              "When you pass: stop trading immediately. Don't donate the pass back to variance.",
            ] },
            { type: "h", text: "Handling failure correctly" },
            { type: "p", text: "If you fail while following every rule of your validated strategy, you met variance — check whether your sizing matched the Monte Carlo drawdown numbers, adjust, and re-enter when calm. If you failed because you broke your own rules, the strategy is fine and the trader isn't: back to the simulator, no discussion. Being honest about which of the two happened is the skill." },
            { type: "tip", text: "Decide BEFORE starting: what exactly triggers a re-attempt vs. a return to sim? Written down. Future-you under emotion will look for loopholes." },
          ],
        },
        {
          id: "fp-funded-phase",
          title: "Funded: cushion first, scale later, payouts",
          minutes: 6,
          body: [
            { type: "p", text: "A fresh funded account is fragile: your equity sits directly on the trailing-drawdown floor. The first weeks have one objective — building cushion — and the discipline profile is 'even more conservative than the evaluation'." },
            { type: "h", text: "The three funded phases" },
            { type: "ul", items: [
              "Fragile (equity near the drawdown floor): minimum size, most conservative filters, skip marginal setups entirely.",
              "Cushioned (buffer > your strategy's 95th-percentile MC drawdown): normal operation at validated size.",
              "Scaling: add ONE micro at a time, only after the cushion covers the new size's drawdown too. Withdraw profits on a fixed schedule — money in the account is still at risk to the rules.",
            ] },
            { type: "h", text: "Payouts & expectations" },
            { type: "p", text: "Firms typically let you keep 100% of early profits up to a threshold, then 80–90%. Regular small withdrawals beat letting the balance grow: withdrawn money is finally, actually yours. Realistic expectation for 1–2 micros traded well: hundreds per month, not thousands — the value of this phase is the track record and the habit set, which are what justify scaling and, later, your own capital." },
            { type: "tip", text: "Keep a simple spreadsheet: fees paid, payouts received, hours worked. If after 6 funded months the net is negative and the process was clean, that is real information about the strategy — respect it." },
          ],
        },
        {
          id: "fp-to-ibkr",
          title: "From prop firm to your own account (IBKR)",
          minutes: 6,
          body: [
            { type: "p", text: "Trading your own capital is the final stage, not the first — because your own drawdown has no reset button and no capped fee. The prop-firm phase exists to prove, with someone else's risk, that your process survives reality." },
            { type: "h", text: "When your own account makes sense" },
            { type: "ul", items: [
              "6+ months of net-profitable funded trading with clean rule-following.",
              "Capital where the strategy's 95th-percentile drawdown is under ~15–20% of the account — for micro futures realistically $10,000+.",
              "That capital is money whose loss changes nothing about your life.",
            ] },
            { type: "h", text: "What changes at IBKR" },
            { type: "ul", items: [
              "Futures need no PDT minimum; commissions per micro round-turn are comparable to prop data costs.",
              "No trailing drawdown, no daily limits, no consistency rules — YOU must now be the risk department. Keep the prop-firm limits as personal rules; they were protecting you.",
              "Automation is your own business now: IBKR has real APIs, and the semi-automated setup can become fully automated at your own risk.",
              "Taxes: you handle reporting yourself (in Switzerland, private capital gains are generally tax-free, but frequent trading can be classified as professional trading — get advice before scaling)." ,
            ] },
            { type: "p", text: "Many funded traders deliberately stay hybrid: prop accounts for size and capped risk, a small own account for full freedom. There is no rule that the path must end at 100% own capital." },
            { type: "tip", text: "The skills are the asset, not the account. Strategy design, validation discipline, and boring execution transfer to every platform, market, and decade. That's what this course was actually about." },
          ],
        },
      ],
    },
  ],
};
