import { useEffect } from "react";
import { useLocation } from "react-router-dom";

// Lightweight per-route <title>/description for the SPA — better UX in the tab
// bar and richer signals for JS-running crawlers (Google, AI answer engines).
// The static index.html tags remain the fallback for non-JS crawlers.
const SUFFIX = " — MMMXCIX Quant";
const ROUTES = [
  ["/charts", "Live Charts", "Live crypto, stock, ETF and FX charts with indicators and drawing tools."],
  ["/backtest", "Backtesting", "Backtest strategies with fees, slippage, walk-forward validation and the Deflated Sharpe Ratio."],
  ["/screener/correlation", "Correlation & Pairs", "Cross-asset correlation matrix and a Kalman/OU pairs mean-reversion tool."],
  ["/screener", "Screener", "Scan markets for signals, anomalies and cross-asset correlation."],
  ["/map", "Live World Map", "Live ships, aircraft, satellites, quakes, fires, conflicts and infrastructure on one map."],
  ["/macro", "Macro & Bond Yields", "Global yield curves, inversion signals and macro data."],
  ["/news", "Market News", "A market-news digest with a personalised daily email."],
  ["/portfolio", "Portfolio", "A simulated book with realized P/L and a Hierarchical Risk Parity allocation."],
  ["/regimes", "Market Regimes", "Hidden-Markov market-regime detection, live vs hindsight."],
  ["/learn", "Learn Quant", "An academy, strategy guide and a reference of 30+ quant formulas."],
  ["/coach", "Coach", "A personalised plan to build quant-trading skill."],
  ["/tools", "Tools", "Handy quant utilities."],
  ["/", "Dashboard", "Free, private, browser-based quant tools: backtesting, ML, screener, charts, macro and a live world map."],
];

export default function RouteSeo() {
  const { pathname } = useLocation();
  useEffect(() => {
    const hit = ROUTES.find(([p]) => pathname === p || pathname.startsWith(p + "/")) || ROUTES[ROUTES.length - 1];
    const [, name, desc] = hit;
    document.title = name + SUFFIX;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) { meta = document.createElement("meta"); meta.setAttribute("name", "description"); document.head.appendChild(meta); }
    meta.setAttribute("content", desc);
    let canon = document.querySelector('link[rel="canonical"]');
    if (!canon) { canon = document.createElement("link"); canon.setAttribute("rel", "canonical"); document.head.appendChild(canon); }
    canon.setAttribute("href", "https://quant.mmmxcix.com" + pathname);
  }, [pathname]);
  return null;
}
