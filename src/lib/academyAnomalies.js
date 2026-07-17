// Academy course: Anomalies & Factor Investing. Companion to the /anomalies
// page — every lesson here has a live counterpart there, so each claim can be
// checked against current market data instead of being taken on faith.

export const ANOMALIES_COURSE = {
  id: "anomalies-factors",
  title: "Anomalies & Factor Investing",
  description: "Documented market edges and the risk geometry behind them — every claim recomputable live on the Anomalies page.",
  levels: [
    {
      id: "anom-edges",
      title: "Documented anomalies",
      description: "Three published return anomalies: what they are, why they existed, and what is left of them.",
      lessons: [
        {
          id: "anom-what-is-an-anomaly",
          title: "What is a market anomaly?",
          minutes: 6,
          body: [
            { type: "p", text: "In a perfectly efficient market, no public information should predict returns beyond compensation for risk. A market anomaly is a documented, persistent pattern that breaks this: some observable characteristic — a stock's beta, an accounting ratio, its short interest — predicted future returns for years or decades after researchers published it." },
            { type: "h", text: "Where anomalies come from" },
            { type: "ul", items: [
              "Risk compensation: the 'anomaly' is real payment for a real risk the simple models miss. It should persist, because someone must be paid to carry the risk.",
              "Behavioral: systematic mistakes by investors — chasing lottery-like stocks, fixating on headline earnings, extrapolating the recent past. It persists only while the mistake does.",
              "Structural (limits to arbitrage): everyone can see the mispricing, but constraints — leverage limits, borrow costs, career risk — stop professionals from fully correcting it.",
            ] },
            { type: "h", text: "The most important fact: publication decay" },
            { type: "p", text: "McLean and Pontiff studied 97 published return predictors and found that the average long-short return shrinks by roughly 58% after publication. Capital flows toward known edges and prices them away. Any anomaly you read about is, on average, about half as strong as the paper that made it famous — sometimes far weaker." },
            { type: "p", text: "This is why every module on the Anomalies page carries a 'reality check' box. The honest question is never 'did this work in the backtest?' but 'what is left of it now, after costs, at the size I could actually trade?'" },
            { type: "tip", text: "In the tool: the Anomalies page recomputes three classic anomalies on live data over a 40-stock universe — you can watch how well (or badly) each one is doing right now instead of trusting a 30-year-old chart." },
          ],
        },
        {
          id: "anom-betting-against-beta",
          title: "Betting Against Beta — the low-risk puzzle",
          minutes: 7,
          body: [
            { type: "p", text: "The CAPM makes a clean promise: more market risk (beta), more expected return. Empirically the promise fails — the line relating beta to realized return is far too flat, and risk-adjusted, low-beta stocks have beaten high-beta stocks for decades. 'The riskier the stock, the worse the return' is an exaggeration, but per unit of risk it has been true." },
            { type: "h", text: "Why: the leverage constraint" },
            { type: "p", text: "Frazzini and Pedersen's explanation is structural. Many investors who want high returns cannot (or will not) use leverage — pension funds, mutual funds, most retail. Their substitute for leverage is buying high-beta stocks, which bids those up and depresses their future returns. Low-beta stocks are left cheap for anyone who CAN lever them." },
            { type: "h", text: "The BAB construction" },
            { type: "p", text: "Rank stocks by their trailing beta. Buy the low-beta bucket, levered UP to a beta of one; short the high-beta bucket, delevered DOWN to a beta of one. The portfolio is roughly market-neutral and harvests the spread between cheap boring stocks and expensive exciting ones. Rebalance monthly as betas drift." },
            { type: "formula", text: "r_BAB = (1/β_low) · r_low − (1/β_high) · r_high" },
            { type: "p", text: "In the original 1926–2012 US sample, this factor earned a Sharpe ratio of 0.78 — roughly double the value factor over the same period." },
            { type: "h", text: "Reality check" },
            { type: "ul", items: [
              "Since ~2020 BAB has struggled: crowding into low-vol strategies, high financing costs for the leverage it needs, and compressed beta dispersion.",
              "Novy-Marx & Velikov ('Betting against betting against beta', 2022) showed the paper's construction quietly overweights illiquid small caps — realistic trading costs eat much of the premium.",
              "Shorting the high-beta bucket in a bull market means shorting the market's favorite stocks. The live module often shows exactly this pain.",
            ] },
            { type: "tip", text: "In the tool: Anomalies → Betting Against Beta runs the full construction live — rolling betas, monthly rebalance, leg leverage, equity curves vs SPY, and the beta-vs-return scatter that should slope up but usually doesn't." },
          ],
        },
        {
          id: "anom-accruals",
          title: "The accruals anomaly — earnings quality",
          minutes: 6,
          body: [
            { type: "p", text: "Reported earnings are not cash. Earnings = operating cash flow + accruals, where accruals are accounting adjustments — receivables booked but not collected, inventory built but not sold. Accruals are less persistent than cash flows and far easier to massage." },
            { type: "h", text: "Sloan (1996)" },
            { type: "p", text: "Richard Sloan — an accounting professor, the 'accountant' of the meme — showed the market does not get this. Investors fixate on the headline earnings number and ignore its composition. Firms with high accruals (paper earnings) went on to underperform firms with low accruals (cash-backed earnings) by around 10% per year, for decades, using only public filings." },
            { type: "formula", text: "accruals ratio = (net income − operating cash flow) / avg total assets" },
            { type: "p", text: "A negative ratio means the company generates MORE cash than it reports as profit — conservative, cash-backed earnings. A large positive ratio means profit exists mostly on paper." },
            { type: "h", text: "Reality check" },
            { type: "ul", items: [
              "This is the textbook arbitraged-away anomaly: returns became unreliable after ~2002 as hedge funds crowded in and analysts began publishing cash-flow forecasts alongside earnings.",
              "What survives concentrates in small, illiquid names where trading costs are ugly.",
              "The concept still earns its keep inside quality factors: as an earnings-quality LENS, not a standalone signal.",
            ] },
            { type: "tip", text: "In the tool: Anomalies → Accruals ranks the whole universe by the Sloan ratio from the latest annual filings — check which mega caps currently run on cash and which on paper." },
          ],
        },
        {
          id: "anom-short-interest",
          title: "Short interest — following informed sellers",
          minutes: 6,
          body: [
            { type: "p", text: "Short sellers pay borrow fees, face unlimited theoretical losses, and risk squeezes — nobody does it casually. That makes short interest (how much of a stock's float is sold short) one of the most information-dense public datasets: it is a real-money census of who is betting against each stock, published for decades." },
            { type: "h", text: "The evidence" },
            { type: "ul", items: [
              "Heavily shorted stocks have historically underperformed — in the most short-sale-constrained names by as much as ~2% per MONTH.",
              "The effect appears at the market level too: high aggregate short interest predicts lower next-month market returns (~0.6% internationally).",
              "The mechanism: shorting frictions (borrow cost, availability) slow how fast negative information gets into prices — so high short interest means bad news still in the pipeline.",
            ] },
            { type: "h", text: "Reality check" },
            { type: "ul", items: [
              "Still among the more robust anomalies — but it concentrates in speculative-grade, hard-to-borrow names, not liquid mega caps.",
              "Harvesting it directly means shorting exactly where borrow is most expensive and squeezes happen. GameStop 2021 is the permanent warning label.",
              "Controlling for the fundamental news short sellers anticipate, much of the cross-sectional effect disappears: it is informed trading, not free money.",
              "The practical long-only use: treat crowded shorts as a caution flag on your OWN longs, not as a short list.",
            ] },
            { type: "tip", text: "In the tool: Anomalies → Short Interest ranks the universe by short % of float and days-to-cover, with month-over-month changes — 'crowded' flags mark names where the shorts have piled in." },
          ],
        },
      ],
    },
    {
      id: "anom-geometry",
      title: "Risk geometry",
      description: "Correlation regimes, drawdown distributions, and the option surface — how professionals picture risk.",
      lessons: [
        {
          id: "anom-correlation-regimes",
          title: "Correlation regimes & diversification breakdown",
          minutes: 6,
          body: [
            { type: "p", text: "The correlation number in your portfolio tool is an average over calm and stressed days — and the two regimes are nothing alike. In quiet markets a basket of stocks, bonds, gold and crypto genuinely diversifies. In a crisis, forced selling and margin calls hit everything at once and correlations lurch toward 1. Diversification fails precisely when it is needed." },
            { type: "h", text: "The evidence" },
            { type: "ul", items: [
              "2008 and March 2020 are the canonical examples: cross-asset correlations spiked as liquidity-driven selling swept every market.",
              "Regime-switching models (calm state / crisis state, each with its own volatilities and correlations) capture fat tails and correlation spikes that a single static covariance matrix cannot.",
              "The diversification ratio — average asset volatility divided by portfolio volatility — quantifies it: high when diversification works, sliding toward 1 when the basket becomes one big trade.",
            ] },
            { type: "h", text: "What to do with it" },
            { type: "p", text: "This is not a decayed anomaly — it is a structural fact of markets. Size positions against the STRESS-regime correlation matrix, not the calm one; a portfolio that only works under calm correlations is leveraged to an assumption. Rising average pairwise correlation is itself a useful early de-risking signal." },
            { type: "tip", text: "In the tool: Anomalies → Correlation Regimes measures a 6-asset basket live — rolling average correlation with stress shading, and the calm-vs-stress correlation matrices side by side. Watch the off-diagonal cells brighten under stress." },
          ],
        },
        {
          id: "anom-drawdown-topology",
          title: "Drawdown topology — the shape of risk",
          minutes: 6,
          body: [
            { type: "p", text: "'12% return, 22% volatility' sounds like one number pair — it is actually a whole landscape of possible experiences. Simulate thousands of paths with those statistics and fat tails, and track each path's drawdown (the distance below its own high-water mark), and you get a topology: a surface showing where the paths live over time." },
            { type: "formula", text: "drawdown_t = (peak_t − equity_t) / peak_t" },
            { type: "h", text: "How to read the landscape" },
            { type: "ul", items: [
              "The ridge along 0%: most paths hover near their highs most of the time — that is what a positive-drift asset looks like.",
              "The shelf sliding away: the fat tail. A meaningful minority of paths spend months 20%+ underwater even when the strategy is 'working'.",
              "Median max drawdown vs p95 max drawdown: the typical experience vs the bad-luck experience of the SAME strategy. Both are legitimate outcomes of identical statistics.",
            ] },
            { type: "p", text: "The practical use is sizing before trading: if the p95 drawdown of your assumed edge already breaches your pain threshold — or a prop firm's trailing loss limit — the position size is wrong before the first trade. Ordering luck decides which path you personally get; sizing decides whether you survive the unlucky ones." },
            { type: "tip", text: "In the tool: Anomalies → Drawdown Topology renders the 3D drawdown surface for any drift/vol/fat-tail assumption (drag to rotate), with quantile lines, terminal distribution and VaR. Pair it with the Lab, which does the same for a per-trade edge." },
          ],
        },
        {
          id: "anom-greeks-manifold",
          title: "The Greeks manifold — options as a surface",
          minutes: 7,
          body: [
            { type: "p", text: "An option's value is not a number, it is a function of at least spot price and time — a surface. The Greeks every options course teaches are simply that surface's local geometry: delta is its slope along the spot axis, gamma the curvature, theta the slide along the time axis, vega its sensitivity to the volatility input." },
            { type: "h", text: "The three features every buyer must know" },
            { type: "ul", items: [
              "The gamma ridge: near the strike, close to expiry, curvature explodes — small spot moves flip the option between worthless and valuable. This is pin risk, and also why lottery-ticket 0DTE options behave like lightning.",
              "The theta trench: the same region drains value fastest per day. Gamma and theta are two views of the same geometry — the convexity you own is paid for by the time decay you bleed.",
              "The P&L surface vs your premium: far from strike and early in the trade the surface is flat (nothing you do matters); the whole game happens on the ridge near expiry.",
            ] },
            { type: "p", text: "A long call, a long put and a straddle are just different slices of this same geometry. Traders do not manage positions, they manage the surface: how much slope (delta) they carry, how much curvature (gamma) they own or are short, and what that curvature costs per day (theta)." },
            { type: "h", text: "Reality check" },
            { type: "p", text: "The clean manifold assumes one flat volatility. Real chains carry skew and term structure — the market charges more for some regions of the surface than Black-Scholes suggests. Use the live Options page (smile and term-structure views) to see how reality bends the textbook surface." },
            { type: "tip", text: "In the tool: Anomalies → Greeks Manifold renders the P&L, gamma and theta surfaces for calls, puts and straddles (drag to rotate). Then open Options to see the same Greeks computed on live chains." },
          ],
        },
      ],
    },
  ],
};
