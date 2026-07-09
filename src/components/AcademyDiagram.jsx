import XYLineChart from "@/components/XYLineChart";
import { payoffCurve } from "@/lib/options";

// Visual figures embedded in Academy lessons via the { type: "diagram", id,
// caption } block. Two kinds:
//  1. Real option-strategy payoff diagrams, drawn from the payoff engine with
//     synthetic legs (strike 100, illustrative premiums) — the exact shapes.
//  2. Hand-drawn SVG sketches for chart patterns and indicators.

// ── Option payoff diagrams (reuse the real engine) ──────────────────────────

const call = (strike, premium, side, qty = 1) => ({ type: "call", strike, premium, side, qty });
const put = (strike, premium, side, qty = 1) => ({ type: "put", strike, premium, side, qty });
const stock = (side, entry, qty = 1) => ({ kind: "stock", side, entry, qty });

function Payoff({ legs, center = 100, spread = 0.35 }) {
  const { points } = payoffCurve(legs, center, { spread, steps: 100 });
  const series = [{ label: "P/L", color: "#2dd4bf", points }];
  return (
    <XYLineChart
      series={series}
      height={200}
      shadeZero
      markerX={center}
      markerLabel="Spot"
      fmtX={(v) => Math.round(v)}
      fmtY={(v) => (v === 0 ? "0" : `${v > 0 ? "+" : "-"}${Math.abs(Math.round(v))}`)}
    />
  );
}

// ── Sketch primitives ───────────────────────────────────────────────────────

function Sketch({ children, viewBox = "0 0 320 180" }) {
  return (
    <svg viewBox={viewBox} className="w-full" style={{ maxHeight: 200 }} preserveAspectRatio="xMidYMid meet">
      {children}
    </svg>
  );
}
const AXIS = "#334155", GRID = "#1c2433", UP = "#10b981", DOWN = "#ef4444", ACC = "#2dd4bf", BLUE = "#38bdf8", AMBER = "#f59e0b";
const axes = (
  <>
    <line x1="28" y1="10" x2="28" y2="158" stroke={AXIS} strokeWidth="1" />
    <line x1="28" y1="158" x2="310" y2="158" stroke={AXIS} strokeWidth="1" />
  </>
);

// A little candlestick at x with body [yOpen,yClose] and wick [yHi,yLo].
function Candle({ x, o, c, h, l, w = 7 }) {
  const up = c <= o; // lower y = higher price; up candle closes higher (smaller y)
  const col = up ? UP : DOWN;
  const top = Math.min(o, c), bot = Math.max(o, c);
  return (
    <g>
      <line x1={x} y1={h} x2={x} y2={l} stroke={col} strokeWidth="1" />
      <rect x={x - w / 2} y={top} width={w} height={Math.max(1, bot - top)} fill={col} />
    </g>
  );
}

// Support / resistance bounce.
const SupportResistance = () => (
  <Sketch>
    {axes}
    <line x1="28" y1="45" x2="310" y2="45" stroke={DOWN} strokeDasharray="4 3" strokeWidth="1.2" />
    <text x="300" y="40" fontSize="9" fill={DOWN} textAnchor="end" fontFamily="monospace">resistance</text>
    <line x1="28" y1="130" x2="310" y2="130" stroke={UP} strokeDasharray="4 3" strokeWidth="1.2" />
    <text x="300" y="145" fontSize="9" fill={UP} textAnchor="end" fontFamily="monospace">support</text>
    <path d="M35,120 L70,50 L110,125 L150,48 L195,128 L235,52 L285,120" fill="none" stroke={ACC} strokeWidth="1.8" />
  </Sketch>
);

// Consolidation then breakout above resistance.
const Breakout = () => (
  <Sketch>
    {axes}
    <line x1="28" y1="70" x2="210" y2="70" stroke={AMBER} strokeDasharray="4 3" strokeWidth="1.2" />
    <text x="120" y="64" fontSize="9" fill={AMBER} textAnchor="middle" fontFamily="monospace">resistance</text>
    <path d="M35,95 L60,74 L85,96 L110,75 L140,95 L170,76 L205,74 L235,40 L275,20" fill="none" stroke={ACC} strokeWidth="1.8" />
    <circle cx="215" cy="66" r="4" fill={UP} />
    <text x="250" y="15" fontSize="9" fill={UP} textAnchor="middle" fontFamily="monospace">breakout</text>
  </Sketch>
);

// Trend with a pullback to a moving average.
const Pullback = () => (
  <Sketch>
    {axes}
    <path d="M35,140 C90,120 130,90 300,30" fill="none" stroke={AMBER} strokeWidth="1.4" opacity="0.9" />
    <text x="300" y="42" fontSize="9" fill={AMBER} textAnchor="end" fontFamily="monospace">MA</text>
    <path d="M35,145 L75,110 L100,128 L140,88 L165,104 L205,66 L235,82 L285,34" fill="none" stroke={ACC} strokeWidth="1.8" />
    <circle cx="100" cy="128" r="3.5" fill={BLUE} /><circle cx="165" cy="104" r="3.5" fill={BLUE} />
    <text x="165" y="122" fontSize="9" fill={BLUE} textAnchor="middle" fontFamily="monospace">pullback</text>
  </Sketch>
);

// Candlestick anatomy.
const CandleAnatomy = () => (
  <Sketch viewBox="0 0 320 180">
    <Candle x={110} o={70} c={120} h={35} l={150} w={26} />
    <Candle x={210} o={120} c={70} h={35} l={150} w={26} />
    <text x="110" y="170" fontSize="9" fill={UP} textAnchor="middle" fontFamily="monospace">bullish</text>
    <text x="210" y="170" fontSize="9" fill={DOWN} textAnchor="middle" fontFamily="monospace">bearish</text>
    <line x1="132" y1="35" x2="175" y2="35" stroke={AXIS} strokeWidth="0.6" /><text x="178" y="38" fontSize="8" fill="#64748b" fontFamily="monospace">high (wick)</text>
    <line x1="132" y1="70" x2="175" y2="70" stroke={AXIS} strokeWidth="0.6" /><text x="178" y="73" fontSize="8" fill="#64748b" fontFamily="monospace">close</text>
    <line x1="132" y1="120" x2="175" y2="120" stroke={AXIS} strokeWidth="0.6" /><text x="178" y="123" fontSize="8" fill="#64748b" fontFamily="monospace">open</text>
    <line x1="132" y1="150" x2="175" y2="150" stroke={AXIS} strokeWidth="0.6" /><text x="178" y="153" fontSize="8" fill="#64748b" fontFamily="monospace">low (wick)</text>
  </Sketch>
);

// SMA crossover (golden/death cross).
const SmaCross = () => (
  <Sketch>
    {axes}
    <path d="M35,120 C110,95 150,70 300,40" fill="none" stroke={BLUE} strokeWidth="1.6" />
    <text x="300" y="52" fontSize="9" fill={BLUE} textAnchor="end" fontFamily="monospace">fast SMA</text>
    <path d="M35,105 C120,100 170,92 300,70" fill="none" stroke={AMBER} strokeWidth="1.6" />
    <text x="300" y="82" fontSize="9" fill={AMBER} textAnchor="end" fontFamily="monospace">slow SMA</text>
    <circle cx="152" cy="90" r="4.5" fill={UP} />
    <text x="152" y="80" fontSize="9" fill={UP} textAnchor="middle" fontFamily="monospace">buy</text>
  </Sketch>
);

// RSI with 70/30 bands.
const RsiLevels = () => (
  <Sketch>
    {axes}
    <line x1="28" y1="45" x2="310" y2="45" stroke={DOWN} strokeDasharray="4 3" strokeWidth="1" />
    <text x="32" y="40" fontSize="9" fill={DOWN} fontFamily="monospace">70 overbought</text>
    <line x1="28" y1="120" x2="310" y2="120" stroke={UP} strokeDasharray="4 3" strokeWidth="1" />
    <text x="32" y="134" fontSize="9" fill={UP} fontFamily="monospace">30 oversold</text>
    <path d="M35,90 C70,40 95,42 120,95 C150,150 175,140 205,60 C235,20 260,35 285,100" fill="none" stroke="#a78bfa" strokeWidth="1.8" />
  </Sketch>
);

// Bollinger Bands.
const Bollinger = () => (
  <Sketch>
    {axes}
    <path d="M35,55 C110,40 180,50 300,35" fill="none" stroke="#64748b" strokeWidth="1" />
    <path d="M35,130 C110,120 180,125 300,110" fill="none" stroke="#64748b" strokeWidth="1" />
    <path d="M35,92 C110,80 180,88 300,72" fill="none" stroke={AMBER} strokeDasharray="3 3" strokeWidth="1" />
    <text x="300" y="30" fontSize="9" fill="#64748b" textAnchor="end" fontFamily="monospace">upper</text>
    <text x="300" y="122" fontSize="9" fill="#64748b" textAnchor="end" fontFamily="monospace">lower</text>
    <path d="M35,95 L70,70 L100,105 L140,60 L170,120 L205,75 L245,118 L285,80" fill="none" stroke={ACC} strokeWidth="1.6" />
  </Sketch>
);

// ── Registry ────────────────────────────────────────────────────────────────

const DIAGRAMS = {
  // Option payoffs
  "payoff-long-call": () => <Payoff legs={[call(100, 4, "long")]} />,
  "payoff-long-put": () => <Payoff legs={[put(100, 4, "long")]} />,
  "payoff-covered-call": () => <Payoff legs={[stock("long", 100), call(110, 3, "short")]} />,
  "payoff-cash-secured-put": () => <Payoff legs={[put(95, 3, "short")]} />,
  "payoff-bull-call": () => <Payoff legs={[call(100, 4, "long"), call(110, 2, "short")]} />,
  "payoff-bear-put": () => <Payoff legs={[put(100, 4, "long"), put(90, 2, "short")]} />,
  "payoff-straddle": () => <Payoff legs={[call(100, 4, "long"), put(100, 4, "long")]} spread={0.45} />,
  "payoff-strangle": () => <Payoff legs={[call(107, 2.5, "long"), put(93, 2.5, "long")]} spread={0.45} />,
  "payoff-iron-condor": () => <Payoff legs={[put(90, 1, "long"), put(95, 2, "short"), call(105, 2, "short"), call(110, 1, "long")]} spread={0.3} />,
  "payoff-butterfly": () => <Payoff legs={[call(90, 12, "long"), call(100, 6, "short", 2), call(110, 2, "long")]} spread={0.3} />,
  // Sketches
  "pattern-support-resistance": SupportResistance,
  "pattern-breakout": Breakout,
  "pattern-pullback": Pullback,
  "candle-anatomy": CandleAnatomy,
  "indicator-sma-cross": SmaCross,
  "indicator-rsi": RsiLevels,
  "indicator-bollinger": Bollinger,
};

export default function AcademyDiagram({ id, caption }) {
  const Comp = DIAGRAMS[id];
  if (!Comp) return null;
  return (
    <figure className="rounded-lg border border-line bg-bg/40 p-3 my-1">
      <Comp />
      {caption && <figcaption className="text-[11px] text-dim text-center mt-1">{caption}</figcaption>}
    </figure>
  );
}
