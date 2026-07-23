import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Sigma, Search, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

// The quant formula reference — 30 formulas every aspiring quant meets,
// each with the plain-language version AND a link to where it actually
// lives in this tool. Formulas are universal math (rendered as Unicode,
// no LaTeX dependency); the tool links are what make this page ours.

const CATEGORIES = [
  {
    id: "prob",
    title: "Probability & statistics",
    blurb: "The foundation of every quantitative model.",
    items: [
      { name: "Bayes' theorem", f: "P(A|B) = P(B|A)·P(A) / P(B)", says: "Update your belief when new evidence arrives.", here: "The HMM regime model runs this every bar: prior × likelihood = posterior.", to: "/regimes", label: "Regimes" },
      { name: "Conditional probability", f: "P(A|B) = P(A∩B) / P(B)", says: "Probability of A given that B already happened.", here: "Every regime gate and event study is a conditional probability in disguise." },
      { name: "Expected value", f: "E[X] = Σ xᵢ·P(xᵢ)", says: "The long-run average outcome.", here: "Mean event move in the Event Lab; mean return per regime.", to: "/backtest/events", label: "Event Lab" },
      { name: "Variance", f: "Var(X) = E[(X − μ)²]", says: "How wildly outcomes scatter around their mean.", here: "Annualised vol per regime; the GARCH sizing input.", to: "/regimes", label: "Regimes" },
      { name: "Covariance", f: "Cov(X,Y) = E[(X−μₓ)(Y−μᵧ)]", says: "Do two things move together, in raw units?", here: "The building block of the correlation matrix.", to: "/screener/correlation", label: "Correlation" },
      { name: "Correlation", f: "ρ = Cov(X,Y) / (σₓ·σᵧ)   ∈ [−1, 1]", says: "Covariance, standardised so it's comparable.", here: "The whole Correlation tab — pairwise-complete Pearson on log returns.", to: "/screener/correlation", label: "Correlation" },
      { name: "Z-score", f: "z = (x − μ) / σ", says: "How unusual is this value, in standard deviations?", here: "Volume z-score in ML features; anomaly screens.", to: "/backtest/ml", label: "ML Studio" },
      { name: "Law of large numbers", f: "X̄ₙ → μ   (n → ∞)", says: "Averages converge to the truth — eventually.", here: "Why the Event Lab labels 8 events an anecdote and why the live track record needs time.", to: "/backtest/ml", label: "Track record" },
    ],
  },
  {
    id: "linalg",
    title: "Linear algebra & optimisation",
    blurb: "The mathematical backbone of portfolio construction and ML.",
    items: [
      { name: "Matrix multiplication", f: "C = AB,   cᵢⱼ = Σₖ aᵢₖ·bₖⱼ", says: "Chain linear transformations.", here: "Every neural / regression forward pass in ML Studio." },
      { name: "Matrix inverse", f: "A⁻¹A = I", says: "Undo a linear transformation.", here: "Solving regressions (hedge ratios, factor loadings)." },
      { name: "Eigenvalues & -vectors", f: "Av = λv", says: "The directions a transformation only stretches.", here: "PCA on the covariance matrix = the market's dominant risk factors." },
      { name: "Covariance matrix", f: "Σᵢⱼ = Cov(Xᵢ, Xⱼ)", says: "All pairwise risk relationships in one object.", here: "The Correlation heatmap IS this matrix, standardised.", to: "/screener/correlation", label: "Correlation" },
      { name: "Gradient", f: "∇f = [∂f/∂x₁ … ∂f/∂xₙ]ᵀ", says: "The direction of steepest ascent.", here: "How every model in ML Studio is trained (gradient boosting: literally)." },
      { name: "Hessian", f: "H(f) = [∂²f/∂xᵢ∂xⱼ]", says: "Curvature — distinguishes peaks, valleys, saddles.", here: "Second-order optimisers; convexity of loss surfaces." },
      { name: "Lagrange multipliers", f: "∇f = λ·∇g   subject to g(x)=0", says: "Optimise under a constraint.", here: "Markowitz portfolios are exactly this: max return s.t. risk budget." },
    ],
  },
  {
    id: "stoch",
    title: "Calculus & stochastic processes",
    blurb: "How prices move — the mathematics of randomness over time.",
    items: [
      { name: "Taylor expansion", f: "f(x) ≈ f(a) + f′(a)(x−a) + ½f″(a)(x−a)²", says: "Approximate any smooth function locally.", here: "Where Greeks (delta/gamma) and Itô's ½σ² term come from." },
      { name: "Chain rule", f: "dy/dx = (dy/du)·(du/dx)", says: "Differentiate through compositions.", here: "Backpropagation; transforming log returns to prices." },
      { name: "Wiener process", f: "W₀=0,  Wₜ−Wₛ ~ N(0, t−s)", says: "Pure randomness accumulated over time.", here: "The noise term in every price model below." },
      { name: "Itô's lemma", f: "df = (∂f/∂t + μ∂f/∂x + ½σ²∂²f/∂x²)dt + σ(∂f/∂x)dW", says: "The chain rule for stochastic processes — with the famous extra ½σ² term.", here: "The bridge from a price SDE to option prices." },
      { name: "Geometric Brownian Motion", f: "dSₜ = μSₜdt + σSₜdWₜ", says: "The standard stock-price model: drift + proportional noise.", here: "The assumption the noise test perturbs and Monte Carlo resamples.", to: "/backtest", label: "Backtest" },
      { name: "SDE (general)", f: "dXₜ = μ(Xₜ,t)dt + σ(Xₜ,t)dWₜ", says: "Evolution driven partly by randomness.", here: "GARCH vol targeting is a discretised SDE for variance." },
      { name: "Ornstein-Uhlenbeck", f: "dXₜ = θ(μ − Xₜ)dt + σdWₜ", says: "Mean reversion: the further from μ, the harder it's pulled back.", here: "The maths behind every mean-reversion builder strategy.", to: "/backtest", label: "Builders" },
    ],
  },
  {
    id: "pricing",
    title: "Derivatives pricing",
    blurb: "What options are worth — and why the market's prices are hard to beat.",
    items: [
      { name: "Black-Scholes (call)", f: "C = S·N(d₁) − K·e⁻ʳᵀ·N(d₂)", says: "Fair value of a European call under GBM.", here: "Why the Event Lab straddle usually loses: the premium already prices the move.", to: "/backtest/events", label: "Event Lab" },
      { name: "d₁ and d₂", f: "d₁ = [ln(S/K) + (r + ½σ²)T] / (σ√T),   d₂ = d₁ − σ√T", says: "Standardised distances between spot and strike.", here: "The inputs behind the option chain the Options page reads.", to: "/portfolio/options", label: "Options" },
      { name: "Put-call parity", f: "C − P = S − K·e⁻ʳᵀ", says: "Calls and puts are linked by arbitrage — no model needed.", here: "The sanity check professional desks run before anything else." },
      { name: "Delta", f: "Δ = ∂C/∂S = N(d₁)", says: "How much the option moves per $1 of the underlying.", here: "An ATM straddle is delta-neutral at entry — that's WHY it's a pure volatility bet.", to: "/backtest/events", label: "Event Lab" },
    ],
  },
  {
    id: "portfolio",
    title: "Portfolio & risk",
    blurb: "Sizing, judging and surviving — where theory meets your account.",
    items: [
      { name: "Sharpe ratio", f: "S = (Rₚ − R_f) / σₚ", says: "Return per unit of risk — the lingua franca of performance.", here: "Every gauntlet verdict; and why we deflate it (next).", to: "/backtest", label: "Backtest" },
      { name: "Deflated Sharpe", f: "DSR = P(Sharpe > 0 | trials, skew, kurtosis)", says: "A Sharpe that admits how many things you tried before finding it.", here: "Cortex's core promotion hurdle — every attempt, scan and probe raises the bar.", to: "/cortex/registry", label: "Cortex" },
      { name: "Kelly criterion", f: "f* = p − (1−p)/b", says: "The bet size that maximises long-run growth.", here: "The Event Lab computes it per event study — and says when it's zero.", to: "/backtest/events", label: "Event Lab" },
      { name: "CAPM", f: "E[Rᵢ] = R_f + βᵢ(E[R_m] − R_f)", says: "Only systematic risk earns a premium.", here: "The benchmark every 'edge' must beat: our buy-&-hold comparison." },
      { name: "Max drawdown", f: "MDD = max (peak − trough) / peak", says: "The worst peak-to-valley loss — the number that ends careers.", here: "RiskGate limits, the incubation watchdog's budget, every profile rule.", to: "/cortex/riskgate", label: "RiskGate" },
      { name: "Vol targeting", f: "wₜ = σ_target / σ̂ₜ  (capped ≤ 1)", says: "Size down when markets get violent.", here: "The GARCH sizing every promoted strategy runs with.", to: "/coach", label: "Coach" },
    ],
  },
];

export default function Formulas() {
  const [q, setQ] = useState("");
  const cats = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return CATEGORIES;
    return CATEGORIES.map((c) => ({
      ...c,
      items: c.items.filter((i) => `${i.name} ${i.says} ${i.here}`.toLowerCase().includes(s)),
    })).filter((c) => c.items.length);
  }, [q]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <Sigma className="w-5 h-5 text-accent" />
        <h1 className="text-xl font-bold">The quant formula reference</h1>
      </div>
      <p className="text-sm text-dim mb-4 max-w-2xl leading-relaxed">
        Thirty formulas that carry most of quantitative finance — each with what it actually
        says, and where it's working for you inside this tool right now.
      </p>
      <div className="relative max-w-xs mb-6">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search formulas…"
          className="input-base w-full !pl-8 text-sm" />
      </div>

      <div className="space-y-8">
        {cats.map((c) => (
          <section key={c.id}>
            <h2 className="font-semibold mb-0.5">{c.title}</h2>
            <p className="text-xs text-dim mb-3">{c.blurb}</p>
            <div className="grid md:grid-cols-2 gap-3">
              {c.items.map((i) => (
                <div key={i.name} className="rounded-xl border border-line lg-glass p-4 hover-lift">
                  <p className="text-sm font-semibold mb-1.5">{i.name}</p>
                  <p className="font-mono text-[13px] text-accent bg-bg/40 border border-line/60 rounded-lg px-3 py-2 mb-2 overflow-x-auto whitespace-nowrap">
                    {i.f}
                  </p>
                  <p className="text-xs text-text/90 leading-relaxed mb-1">{i.says}</p>
                  <p className="text-[11px] text-dim leading-relaxed">
                    <span className="text-dim/70 uppercase tracking-wide text-[9px] mr-1">here</span>
                    {i.here}
                    {i.to && (
                      <Link to={i.to} className="inline-flex items-center gap-0.5 text-accent hover:underline ml-1.5">
                        {i.label} <ArrowRight className="w-3 h-3" />
                      </Link>
                    )}
                  </p>
                </div>
              ))}
            </div>
          </section>
        ))}
        {cats.length === 0 && <p className="text-sm text-dim">No formula matches.</p>}
      </div>

      <p className="text-xs text-dim mt-8 leading-relaxed max-w-2xl">
        Formulas are the easy part — the hard part is remembering what they assume. GBM assumes
        continuous smooth randomness (markets gap), Black-Scholes assumes constant volatility
        (it isn't), Kelly assumes you know p and b (you estimated them). Every tool page linked
        above exists to test those assumptions against data instead of trusting them.
      </p>
    </div>
  );
}
