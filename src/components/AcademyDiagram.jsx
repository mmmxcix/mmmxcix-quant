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

// Hammer (bullish rejection) and shooting star (bearish rejection), each in
// its trend context.
const HammerStar = () => (
  <Sketch>
    {axes}
    {/* downtrend into a hammer, then reversal */}
    <Candle x={50} o={50} c={62} h={46} l={66} />
    <Candle x={68} o={62} c={74} h={58} l={78} />
    <Candle x={86} o={74} c={86} h={70} l={90} />
    <Candle x={106} o={92} c={82} h={78} l={130} w={9} />
    <Candle x={126} o={80} c={56} h={52} l={84} />
    <text x={106} y={144} fontSize="9" fill={UP} textAnchor="middle" fontFamily="monospace">hammer</text>
    <text x={106} y={154} fontSize="8" fill="#64748b" textAnchor="middle" fontFamily="monospace">long lower wick</text>
    {/* uptrend into a shooting star, then reversal */}
    <Candle x={206} o={104} c={92} h={88} l={108} />
    <Candle x={224} o={92} c={80} h={76} l={96} />
    <Candle x={242} o={80} c={68} h={64} l={84} />
    <Candle x={262} o={68} c={78} h={30} l={82} w={9} />
    <Candle x={282} o={80} c={104} h={76} l={108} />
    <text x={262} y={144} fontSize="9" fill={DOWN} textAnchor="middle" fontFamily="monospace">shooting star</text>
    <text x={262} y={154} fontSize="8" fill="#64748b" textAnchor="middle" fontFamily="monospace">long upper wick</text>
  </Sketch>
);

// Bullish and bearish engulfing: the second body completely swallows the first.
const Engulfing = () => (
  <Sketch>
    {axes}
    <Candle x={62} o={76} c={88} h={72} l={92} />
    <Candle x={82} o={88} c={100} h={84} l={104} w={9} />
    <Candle x={104} o={104} c={76} h={70} l={110} w={13} />
    <Candle x={124} o={74} c={54} h={50} l={78} />
    <text x={92} y={130} fontSize="9" fill={UP} textAnchor="middle" fontFamily="monospace">bullish engulfing</text>
    <Candle x={212} o={96} c={84} h={80} l={100} />
    <Candle x={232} o={84} c={74} h={70} l={88} w={9} />
    <Candle x={254} o={70} c={98} h={64} l={104} w={13} />
    <Candle x={274} o={100} c={122} h={96} l={126} />
    <text x={244} y={145} fontSize="9" fill={DOWN} textAnchor="middle" fontFamily="monospace">bearish engulfing</text>
  </Sketch>
);

// Doji (indecision) and inside bar (compression within the prior range).
const DojiInside = () => (
  <Sketch>
    {axes}
    <Candle x={80} o={88} c={90} h={56} l={122} w={12} />
    <text x={80} y={140} fontSize="9" fill={AMBER} textAnchor="middle" fontFamily="monospace">doji</text>
    <text x={80} y={151} fontSize="8" fill="#64748b" textAnchor="middle" fontFamily="monospace">open ≈ close: indecision</text>
    <Candle x={200} o={112} c={62} h={52} l={122} w={12} />
    <Candle x={224} o={95} c={80} h={74} l={100} w={9} />
    <line x1={190} y1={52} x2={244} y2={52} stroke={AMBER} strokeDasharray="3 3" strokeWidth="1" />
    <line x1={190} y1={122} x2={244} y2={122} stroke={AMBER} strokeDasharray="3 3" strokeWidth="1" />
    <text x={216} y={140} fontSize="9" fill={AMBER} textAnchor="middle" fontFamily="monospace">inside bar</text>
    <text x={216} y={151} fontSize="8" fill="#64748b" textAnchor="middle" fontFamily="monospace">held inside the prior range</text>
  </Sketch>
);

// Market structure: higher highs/lows vs. lower highs/lows.
const TrendStructure = () => (
  <Sketch>
    {axes}
    <text x={90} y={22} fontSize="9" fill={UP} textAnchor="middle" fontFamily="monospace">uptrend: HH + HL</text>
    <path d="M35,140 L62,100 L78,120 L104,78 L120,98 L146,58" fill="none" stroke={UP} strokeWidth="1.8" />
    <circle cx="62" cy="100" r="3" fill={UP} /><text x="62" y="92" fontSize="8" fill={UP} textAnchor="middle" fontFamily="monospace">HH</text>
    <circle cx="104" cy="78" r="3" fill={UP} /><text x="104" y="70" fontSize="8" fill={UP} textAnchor="middle" fontFamily="monospace">HH</text>
    <circle cx="78" cy="120" r="3" fill={BLUE} /><text x="78" y="134" fontSize="8" fill={BLUE} textAnchor="middle" fontFamily="monospace">HL</text>
    <circle cx="120" cy="98" r="3" fill={BLUE} /><text x="120" y="112" fontSize="8" fill={BLUE} textAnchor="middle" fontFamily="monospace">HL</text>
    <text x={235} y={22} fontSize="9" fill={DOWN} textAnchor="middle" fontFamily="monospace">downtrend: LH + LL</text>
    <path d="M182,58 L208,98 L224,80 L250,118 L266,100 L292,140" fill="none" stroke={DOWN} strokeWidth="1.8" />
    <circle cx="224" cy="80" r="3" fill={DOWN} /><text x="224" y="72" fontSize="8" fill={DOWN} textAnchor="middle" fontFamily="monospace">LH</text>
    <circle cx="266" cy="100" r="3" fill={DOWN} /><text x="266" y="92" fontSize="8" fill={DOWN} textAnchor="middle" fontFamily="monospace">LH</text>
    <circle cx="208" cy="98" r="3" fill={AMBER} /><text x="208" y="112" fontSize="8" fill={AMBER} textAnchor="middle" fontFamily="monospace">LL</text>
    <circle cx="250" cy="118" r="3" fill={AMBER} /><text x="250" y="132" fontSize="8" fill={AMBER} textAnchor="middle" fontFamily="monospace">LL</text>
  </Sketch>
);

// Order book: bid depth left, ask depth right, the spread between them.
const OrderBookSpread = () => (
  <Sketch>
    <text x={100} y={28} fontSize="9" fill={UP} textAnchor="middle" fontFamily="monospace">bids (buyers)</text>
    <text x={222} y={28} fontSize="9" fill={DOWN} textAnchor="middle" fontFamily="monospace">asks (sellers)</text>
    {[[40, 44], [70, 66], [55, 88], [90, 110], [65, 132]].map(([w, y], i) => (
      <rect key={`b${i}`} x={150 - w} y={y} width={w} height={14} rx={2} fill={UP} opacity={0.75} />
    ))}
    {[[35, 44], [60, 66], [80, 88], [50, 110], [95, 132]].map(([w, y], i) => (
      <rect key={`a${i}`} x={172} y={y} width={w} height={14} rx={2} fill={DOWN} opacity={0.75} />
    ))}
    <line x1={150} y1={38} x2={150} y2={152} stroke={GRID} />
    <line x1={172} y1={38} x2={172} y2={152} stroke={GRID} />
    <line x1={150} y1={160} x2={172} y2={160} stroke={AMBER} strokeWidth="1.5" />
    <text x={161} y={173} fontSize="9" fill={AMBER} textAnchor="middle" fontFamily="monospace">spread</text>
    <text x={144} y={160} fontSize="8" fill="#64748b" textAnchor="end" fontFamily="monospace">best bid</text>
    <text x={178} y={160} fontSize="8" fill="#64748b" textAnchor="start" fontFamily="monospace">best ask</text>
  </Sketch>
);

// Intraday price around VWAP, with pullback entries in an up day.
const VwapAnchor = () => (
  <Sketch>
    {axes}
    <path d="M35,96 C110,90 200,88 300,82" fill="none" stroke={AMBER} strokeWidth="1.6" />
    <text x={300} y={76} fontSize="9" fill={AMBER} textAnchor="end" fontFamily="monospace">VWAP</text>
    <path d="M35,130 L60,70 L85,94 L110,60 L135,86 L165,48 L195,84 L225,40 L260,66 L295,30" fill="none" stroke={ACC} strokeWidth="1.8" />
    <circle cx="85" cy="92" r="3.5" fill={BLUE} />
    <circle cx="135" cy="88" r="3.5" fill={BLUE} />
    <circle cx="195" cy="86" r="3.5" fill={BLUE} />
    <text x={140} y={112} fontSize="9" fill={BLUE} textAnchor="middle" fontFamily="monospace">pullback entries at VWAP</text>
  </Sketch>
);

// MACD: line, signal, histogram, and the bullish cross.
const MacdSketch = () => (
  <Sketch>
    {axes}
    <line x1={28} y1={100} x2={310} y2={100} stroke="#334155" strokeDasharray="3 3" />
    {[-14, -20, -24, -22, -16, -8, 2, 10, 16, 20, 22, 20, 16, 10, 2, -4, -8, -10].map((v, i) => {
      const x = 42 + i * 15;
      const h = Math.abs(v);
      return <rect key={i} x={x - 4} y={v > 0 ? 100 - h : 100} width={8} height={h} rx={1.5}
        fill={v > 0 ? UP : DOWN} opacity={0.35} />;
    })}
    <path d="M35,128 C80,140 115,112 150,86 C190,58 235,52 300,78" fill="none" stroke={BLUE} strokeWidth="1.8" />
    <path d="M35,116 C85,126 125,112 165,94 C205,76 245,66 300,72" fill="none" stroke={AMBER} strokeWidth="1.6" />
    <circle cx="146" cy="90" r="4" fill={UP} />
    <text x={146} y={78} fontSize="9" fill={UP} textAnchor="middle" fontFamily="monospace">bullish cross</text>
    <text x={300} y={92} fontSize="9" fill={BLUE} textAnchor="end" fontFamily="monospace">MACD</text>
    <text x={300} y={62} fontSize="9" fill={AMBER} textAnchor="end" fontFamily="monospace">signal</text>
  </Sketch>
);

// A fully specified trade: entry, stop one R below, target two R above.
const TradeBracket = () => (
  <Sketch>
    {axes}
    <rect x={110} y={50} width={186} height={45} fill={UP} opacity={0.09} />
    <rect x={110} y={95} width={186} height={30} fill={DOWN} opacity={0.09} />
    <line x1={40} y1={95} x2={296} y2={95} stroke={ACC} strokeDasharray="4 3" strokeWidth="1.2" />
    <line x1={110} y1={50} x2={296} y2={50} stroke={UP} strokeDasharray="4 3" strokeWidth="1.2" />
    <line x1={110} y1={125} x2={296} y2={125} stroke={DOWN} strokeDasharray="4 3" strokeWidth="1.2" />
    <text x={44} y={89} fontSize="9" fill={ACC} fontFamily="monospace">entry</text>
    <text x={114} y={44} fontSize="9" fill={UP} fontFamily="monospace">target (take-profit)</text>
    <text x={114} y={139} fontSize="9" fill={DOWN} fontFamily="monospace">stop-loss</text>
    <Candle x={70} o={108} c={118} h={104} l={122} />
    <Candle x={88} o={116} c={104} h={100} l={120} />
    <Candle x={106} o={102} c={92} h={88} l={106} />
    <circle cx={110} cy={95} r={4} fill={ACC} />
    <Candle x={130} o={94} c={82} h={78} l={98} />
    <Candle x={150} o={84} c={70} h={66} l={88} />
    <Candle x={170} o={72} c={58} h={52} l={76} />
    <line x1={305} y1={50} x2={305} y2={94} stroke={UP} strokeWidth="1.2" />
    <text x={301} y={74} fontSize="8" fill={UP} textAnchor="end" fontFamily="monospace">+2R</text>
    <line x1={305} y1={96} x2={305} y2={125} stroke={DOWN} strokeWidth="1.2" />
    <text x={301} y={114} fontSize="8" fill={DOWN} textAnchor="end" fontFamily="monospace">−1R</text>
  </Sketch>
);

// Opening range breakout: range box, entry above it, stop at the range low,
// target one range-width higher.
const OrbDiagram = () => (
  <Sketch>
    {axes}
    <rect x={35} y={70} width={78} height={40} fill="none" stroke={AMBER} strokeDasharray="4 3" strokeWidth="1.2" />
    <text x={74} y={64} fontSize="8" fill={AMBER} textAnchor="middle" fontFamily="monospace">opening range</text>
    <Candle x={48} o={84} c={94} h={74} l={100} w={6} />
    <Candle x={62} o={94} c={86} h={80} l={104} w={6} />
    <Candle x={76} o={86} c={96} h={78} l={106} w={6} />
    <Candle x={90} o={96} c={84} h={76} l={102} w={6} />
    <Candle x={104} o={84} c={76} h={72} l={92} w={6} />
    <line x1={113} y1={70} x2={300} y2={70} stroke={ACC} strokeDasharray="3 3" strokeWidth="1" />
    <line x1={113} y1={110} x2={300} y2={110} stroke={DOWN} strokeDasharray="3 3" strokeWidth="1" />
    <line x1={113} y1={30} x2={300} y2={30} stroke={UP} strokeDasharray="3 3" strokeWidth="1" />
    <Candle x={126} o={78} c={62} h={58} l={84} w={7} />
    <circle cx={126} cy={68} r={4} fill={ACC} />
    <text x={140} y={84} fontSize="8" fill={ACC} fontFamily="monospace">entry: break of range high</text>
    <Candle x={158} o={62} c={50} h={46} l={66} w={7} />
    <Candle x={190} o={52} c={40} h={36} l={58} w={7} />
    <Candle x={222} o={42} c={32} h={28} l={48} w={7} />
    <text x={296} y={124} fontSize="8" fill={DOWN} textAnchor="end" fontFamily="monospace">stop = range low (1R)</text>
    <text x={296} y={24} fontSize="8" fill={UP} textAnchor="end" fontFamily="monospace">target = +1 range width</text>
  </Sketch>
);

// A trading day in Swiss time: sessions and the prime NY-open window.
const SessionClock = () => {
  const x = (h) => 20 + (h / 24) * 280;
  return (
    <Sketch>
      <text x={20} y={30} fontSize="9" fill="#94a3b8" fontFamily="monospace">your day in Swiss time (CET/CEST)</text>
      <rect x={x(0)} y={72} width={x(9) - x(0)} height={26} rx={3} fill="#1e293b" />
      <rect x={x(9)} y={72} width={x(15.5) - x(9)} height={26} fill="#0f766e" opacity={0.55} />
      <rect x={x(15.5)} y={72} width={x(22) - x(15.5)} height={26} fill="#14b8a6" opacity={0.7} />
      <rect x={x(22)} y={72} width={x(24) - x(22)} height={26} rx={3} fill="#1e293b" />
      <rect x={x(15.5)} y={70} width={x(17.5) - x(15.5)} height={30} fill="none" stroke={ACC} strokeWidth="1.6" rx={3} />
      <text x={x(4.5)} y={89} fontSize="8" fill="#64748b" textAnchor="middle" fontFamily="monospace">Asia / night</text>
      <text x={x(12.2)} y={89} fontSize="8" fill="#d1fae5" textAnchor="middle" fontFamily="monospace">Europe</text>
      <text x={x(19.7)} y={89} fontSize="8" fill="#022c22" textAnchor="middle" fontFamily="monospace">US session</text>
      <line x1={x(16.5)} y1={70} x2={x(16.5)} y2={54} stroke={ACC} strokeWidth="1" />
      <text x={x(16.5)} y={48} fontSize="9" fill={ACC} textAnchor="middle" fontFamily="monospace">NY open 15:30 — prime window to 17:30</text>
      {[0, 6, 12, 18, 24].map((h) => (
        <g key={h}>
          <line x1={x(h)} y1={100} x2={x(h)} y2={106} stroke={AXIS} />
          <text x={x(h)} y={118} fontSize="8" fill="#64748b" textAnchor="middle" fontFamily="monospace">{String(h).padStart(2, "0")}:00</text>
        </g>
      ))}
      <text x={20} y={144} fontSize="8" fill="#64748b" fontFamily="monospace">Europe open 09:00 · US close 22:00 · crypto runs 24/7, busiest in US hours</text>
      <text x={20} y={158} fontSize="8" fill="#64748b" fontFamily="monospace">daylight saving: NY switches ≈2 weeks before Europe — recheck opens in Mar/Oct</text>
    </Sketch>
  );
};

// Trailing a stop under each higher low of an uptrend.
const StopTrailing = () => (
  <Sketch>
    {axes}
    <text x={160} y={22} fontSize="9" fill="#94a3b8" textAnchor="middle" fontFamily="monospace">raise the stop under each higher low</text>
    <path d="M35,140 L70,100 L90,118 L130,75 L150,95 L190,55 L210,72 L250,40 L285,64" fill="none" stroke={ACC} strokeWidth="1.8" />
    <line x1={60} y1={126} x2={112} y2={126} stroke={DOWN} strokeDasharray="4 3" strokeWidth="1.3" />
    <line x1={112} y1={102} x2={172} y2={102} stroke={DOWN} strokeDasharray="4 3" strokeWidth="1.3" />
    <line x1={172} y1={79} x2={232} y2={79} stroke={DOWN} strokeDasharray="4 3" strokeWidth="1.3" />
    <line x1={232} y1={64} x2={290} y2={64} stroke={DOWN} strokeDasharray="4 3" strokeWidth="1.3" />
    <circle cx={285} cy={64} r={4.5} fill="none" stroke={DOWN} strokeWidth="1.5" />
    <text x={285} y={50} fontSize="8" fill={DOWN} textAnchor="middle" fontFamily="monospace">stopped out in profit</text>
    <text x={86} y={138} fontSize="8" fill={DOWN} fontFamily="monospace">stop 1</text>
    <text x={146} y={114} fontSize="8" fill={DOWN} fontFamily="monospace">stop 2</text>
    <text x={206} y={91} fontSize="8" fill={DOWN} fontFamily="monospace">stop 3</text>
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
  "pattern-trend-structure": TrendStructure,
  "pattern-orb": OrbDiagram,
  "candle-anatomy": CandleAnatomy,
  "candle-hammer-star": HammerStar,
  "candle-engulfing": Engulfing,
  "candle-doji-inside": DojiInside,
  "indicator-sma-cross": SmaCross,
  "indicator-rsi": RsiLevels,
  "indicator-bollinger": Bollinger,
  "indicator-macd": MacdSketch,
  "indicator-vwap": VwapAnchor,
  "orderbook-spread": OrderBookSpread,
  "trade-bracket": TradeBracket,
  "session-clock": SessionClock,
  "stop-trailing": StopTrailing,
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
