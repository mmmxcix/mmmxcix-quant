// Correlation-matrix heatmap (SVG). Diverging color: −1 = red, 0 = neutral
// dark, +1 = green — matching the app's up/down polarity. Values are printed
// in every cell, so color is never the only encoding.
export default function Heatmap({ labels, matrix, title }) {
  const n = labels?.length || 0;
  if (!n || !matrix?.length) return null;

  const cell = 44;
  const left = 92; // room for row labels
  const top = 26; // room for the title row of column labels
  const wSvg = left + n * cell;
  const hSvg = top + n * cell;

  return (
    <div className="min-w-0">
      {title && <p className="text-xs text-dim font-medium mb-2">{title}</p>}
      <div className="overflow-x-auto">
        <svg
          width="100%"
          viewBox={`0 0 ${wSvg} ${hSvg}`}
          style={{ maxWidth: wSvg, display: "block" }}
          role="img"
          aria-label={title || "Correlation matrix"}
        >
          {labels.map((l, c) => (
            <text key={`c${c}`} x={left + c * cell + cell / 2} y={top - 8} textAnchor="middle"
              fontSize="9" fill="#64748b" fontFamily="monospace">
              {shortLabel(l)}
            </text>
          ))}
          {labels.map((l, r) => (
            <text key={`r${r}`} x={left - 8} y={top + r * cell + cell / 2 + 3} textAnchor="end"
              fontSize="10" fill="#94a3b8" fontFamily="monospace">
              {l.length > 12 ? l.slice(0, 11) + "…" : l}
            </text>
          ))}
          {matrix.map((row, r) =>
            row.map((v, c) => (
              <g key={`${r}-${c}`}>
                <rect
                  x={left + c * cell + 1} y={top + r * cell + 1}
                  width={cell - 2} height={cell - 2} rx="4"
                  fill={corrColor(v)}
                >
                  <title>{`${labels[r]} × ${labels[c]}: ${v.toFixed(2)}`}</title>
                </rect>
                <text
                  x={left + c * cell + cell / 2} y={top + r * cell + cell / 2 + 3}
                  textAnchor="middle" fontSize="10" fontFamily="monospace"
                  fill={Math.abs(v) > 0.55 ? "#0a0e14" : "#cbd5e1"}
                  pointerEvents="none"
                >
                  {r === c ? "1" : v.toFixed(2)}
                </text>
              </g>
            ))
          )}
        </svg>
      </div>
    </div>
  );
}

function shortLabel(l) {
  return l.length > 7 ? l.slice(0, 6) + "…" : l;
}

// −1 → red, 0 → neutral surface gray, +1 → green (linear RGB lerp is fine at
// this size; values are printed anyway).
export function corrColor(v) {
  const t = Math.max(-1, Math.min(1, v));
  const lerp = (a, b, k) => Math.round(a + (b - a) * k);
  const neutral = [31, 41, 55]; // #1f2937
  const pos = [16, 185, 129]; // up  #10b981
  const neg = [239, 68, 68]; // down #ef4444
  const to = t >= 0 ? pos : neg;
  const k = Math.abs(t);
  return `rgb(${lerp(neutral[0], to[0], k)}, ${lerp(neutral[1], to[1], k)}, ${lerp(neutral[2], to[2], k)})`;
}
