import { useEffect, useRef, useState } from "react";

// CountUp — eases a number from 0 to `value` on mount (and on value changes).
// `format` turns the in-flight number into the displayed string, so callers keep
// full control over currency/percent formatting. Honors prefers-reduced-motion.
export default function CountUp({ value, format = (v) => String(Math.round(v)), duration = 900, className }) {
  const [display, setDisplay] = useState(value);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(value)) { setDisplay(value); return; }
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setDisplay(value); return; }

    const from = 0;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setDisplay(from + (value - from) * eased);
      if (k < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return <span className={className}>{Number.isFinite(display) ? format(display) : display}</span>;
}
