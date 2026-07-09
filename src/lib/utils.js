import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// 1234.5678 → "1,234.57" (US-style thousands separator)
export function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// Adaptive price formatting: sub-1 assets need more decimals.
export function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const digits = n >= 1000 ? 2 : n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  return fmtNum(n, digits);
}

export function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const sign = n > 0 ? "+" : "";
  return `${sign}${fmtNum(n, digits)}%`;
}
