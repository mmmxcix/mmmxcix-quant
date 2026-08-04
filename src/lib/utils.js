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

// How many decimals a price needs to be meaningful — smaller prices carry their
// information in the later digits (XRP at 1.0834 is NOT "1.08"). Scales with
// magnitude so a $63k coin stays at 2 and a $0.08 coin gets 6.
export function priceDecimals(n) {
  const a = Math.abs(Number(n) || 0);
  return a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : a >= 0.01 ? 6 : a >= 0.0001 ? 8 : 10;
}

// Adaptive price formatting: show the full, meaningful number. Trailing zeros are
// trimmed (min 2) so a clean $588.97 doesn't become 588.9700, while XRP shows 1.0834.
export function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.max(2, priceDecimals(n)),
  });
}

export function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  const sign = n > 0 ? "+" : "";
  return `${sign}${fmtNum(n, digits)}%`;
}
