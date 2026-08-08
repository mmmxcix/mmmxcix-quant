import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./landing.css";

export const WELCOMED_KEY = "quant_welcomed";

// The brand mark (two-candle aperture), Pewter via currentColor.
function Mark({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" style={{ color: "var(--pew)" }} aria-hidden="true">
      <g stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <path d="M14 8H8V14" /><path d="M50 8H56V14" /><path d="M14 56H8V50" /><path d="M50 56H56V50" />
      </g>
      <line x1="26" y1="27" x2="26" y2="45" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <rect x="21.5" y="31" width="9" height="10" rx="2.2" fill="currentColor" />
      <line x1="39" y1="19" x2="39" y2="41" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      <rect x="34.5" y="23" width="9" height="14" rx="2.2" fill="currentColor" />
    </svg>
  );
}

// Real registry snapshot — believable Sharpe + real drawdowns, and a genuinely
// buried strategy. No hype returns; the honest figures are the point.
const STRATS = [
  { name: "Breakout · volatility-confirmed", sharpe: "1.39", dd: "29%", status: "paper" },
  { name: "Breakout pullback + vol filter", sharpe: "1.28", dd: "21%", status: "validated" },
  { name: "EMA·RSI·MACD regime breakout", sharpe: "1.27", dd: "41%", status: "paper" },
  { name: "SMA crossover", sharpe: "1.48", dd: "8%", status: "factory" },
  { name: "Square-root price impact", sharpe: "—", dd: "—", status: "buried · bug", grave: true },
];

const FAQ = [
  ["What does it cost?", "Free while in alpha — no account needed to explore the desk. A paid tier will come later for the heavier compute (deep generation, hosted research); the core research tools stay generous."],
  ["Where does my data go?", "Nowhere. Backtests and ML run in your browser; your watchlist and positions live on your device. There's nothing to upload and nothing to leak."],
  ["Is this investment advice?", "No. It's an educational research desk. Backtests are hypothetical and past performance guarantees nothing — which is exactly why every number is shown deflated and out-of-sample."],
  ["Who is behind it?", "An independent quant building the desk in the open — no fund affiliation, no product to pump. The whole pitch is honesty, so the incentives are kept clean."],
];

export default function Landing() {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(WELCOMED_KEY, "1"); } catch { /* private mode */ }
    // The landing is committed-dark — pin the browser status-bar colour dark
    // while it's shown (regardless of the visitor's app theme), then restore.
    const mc = document.querySelector('meta[name="theme-color"]');
    const prevMc = mc && mc.getAttribute("content");
    if (mc) mc.setAttribute("content", "#0b0d12");
    const root = rootRef.current;
    if (!root) return () => { if (mc && prevMc) mc.setAttribute("content", prevMc); };
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const glow = root.querySelector(".glow");
    const onMove = (e) => { if (glow) glow.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; };
    window.addEventListener("pointermove", onMove, { passive: true });

    const nav = root.querySelector("nav");
    const onScroll = () => nav && nav.classList.toggle("stuck", window.scrollY > 40);
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();

    const io = new IntersectionObserver((es) => es.forEach((x) => { if (x.isIntersecting) { x.target.classList.add("in"); io.unobserve(x.target); } }), { threshold: 0.15 });
    root.querySelectorAll(".reveal").forEach((el) => io.observe(el));

    const cio = new IntersectionObserver((es) => es.forEach((x) => {
      if (!x.isIntersecting) return; cio.unobserve(x.target);
      const el = x.target, to = +el.dataset.to; let t0 = null;
      const run = (t) => { t0 = t0 || t; const p = Math.min(1, (t - t0) / 850); el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(run); };
      reduce ? (el.textContent = to) : requestAnimationFrame(run);
    }), { threshold: 0.6 });
    root.querySelectorAll("[data-to]").forEach((el) => cio.observe(el));

    const clk = root.querySelector(".clock");
    const ci = setInterval(() => { if (clk) clk.textContent = new Date().toISOString().slice(11, 19) + " UTC"; }, 1000);

    // streaming candle hero
    let raf = 0, resize = null;
    const cv = canvasRef.current;
    if (cv) {
      const ctx = cv.getContext("2d"); let W, H, dpr;
      resize = () => { dpr = Math.min(2, devicePixelRatio || 1); const r = cv.getBoundingClientRect(); W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
      resize(); window.addEventListener("resize", resize);
      let price = 100; const candles = [];
      const step = () => { const o = price, c = o + 0.5 + (Math.random() - 0.48) * 4.4, h = Math.max(o, c) + Math.random() * 2.4, l = Math.min(o, c) - Math.random() * 2.4; price = c; candles.push({ o, c, h, l }); if (candles.length > 66) candles.shift(); };
      for (let i = 0; i < 54; i++) step(); let last = 0;
      const frame = (now) => {
        if (!reduce && now - last > 820) { step(); last = now; }
        const vis = candles.slice(-48); const hi = Math.max(...vis.map((c) => c.h)), lo = Math.min(...vis.map((c) => c.l)), pad = (hi - lo) * 0.12 || 1, top = lo - pad, bot = hi + pad;
        const Y = (v) => H - 16 - (v - top) / (bot - top) * (H - 46), cw = W / vis.length, bw = Math.min(9, cw * 0.5); ctx.clearRect(0, 0, W, H);
        ctx.strokeStyle = "rgba(148,155,168,.06)"; ctx.lineWidth = 1; for (let g = 0; g < 4; g++) { const y = 16 + g * (H - 32) / 3; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
        ctx.beginPath(); vis.forEach((c, i) => { const x = i * cw + cw / 2, y = Y(c.c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.strokeStyle = "rgba(147,178,216,.2)"; ctx.lineWidth = 2; ctx.stroke(); ctx.lineCap = "round";
        vis.forEach((c, i) => { const x = i * cw + cw / 2, up = c.c >= c.o, near = i >= vis.length - 7; ctx.strokeStyle = ctx.fillStyle = near ? "#93b2d8" : (up ? "rgba(74,194,140,.4)" : "rgba(232,82,88,.4)"); ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(x, Y(c.h)); ctx.lineTo(x, Y(c.l)); ctx.stroke(); const yt = Y(Math.max(c.o, c.c)), hh = Math.max(2, Math.abs(Y(c.o) - Y(c.c))); ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - bw / 2, yt, bw, hh, 2) : ctx.rect(x - bw / 2, yt, bw, hh); ctx.fill(); });
        const lc = vis[vis.length - 1], ex = (vis.length - 1) * cw + cw / 2, ey = Y(lc.c); ctx.fillStyle = "#93b2d8"; ctx.beginPath(); ctx.arc(ex, ey, 3.4, 0, 7); ctx.fill(); ctx.strokeStyle = "rgba(147,178,216,.4)"; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(ex, ey, 7, 0, 7); ctx.stroke();
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", onScroll);
      if (resize) window.removeEventListener("resize", resize);
      io.disconnect(); cio.disconnect(); clearInterval(ci); cancelAnimationFrame(raf);
      if (mc && prevMc) mc.setAttribute("content", prevMc);
    };
  }, []);

  return (
    <div className="lp" ref={rootRef}>
      <div className="glow" />
      <div className="frame"><b /><b /><b /><b /></div>
      <div className="sidelabel">The honest quant desk</div>
      <div className="statusbar"><span><span className="live">● LIVE</span> · MMMXCIX QUANT · v1.0</span><span className="clock m">--:--:-- UTC</span></div>

      <nav>
        <Link className="brand" to="/"><Mark size={30} /><span className="wm"><small>MMMXCIX</small>Quant</span></Link>
        <div className="navlinks"><a href="#honest">Honest</a><a href="#desk">Desk</a><a href="#tools">Tools</a><a href="#faq">Access</a></div>
        <Link className="btn btn-p" to="/">Enter the desk →</Link>
      </nav>

      <header className="hero">
        <canvas ref={canvasRef} />
        <div className="part"><span className="dot" /> <span className="br">[</span> Quantitative research desk <span className="br">/</span> live <span className="br">]</span></div>
        <h1><span className="l"><span>The honest</span></span><span className="l"><span className="grad">quant desk.</span></span></h1>
        <p className="sub">Institutional-grade backtesting, in-browser ML and live markets — private, in your browser. No black boxes, no hype.</p>
        <div className="heroctas"><Link className="btn btn-p" to="/">Enter the desk →</Link><a className="btn btn-g" href="#desk">See the desk ↓</a></div>
        <p className="access">// <b>Free while in alpha</b> · no account needed · your work never leaves your device</p>
        <div className="kpis">
          <div className="kpi"><div className="n"><span data-to="12">0</span></div><div className="k">integrated tools</div></div>
          <div className="kpi"><div className="n"><span data-to="10">0</span>y</div><div className="k">backtest history</div></div>
          <div className="kpi"><div className="n">0<span className="u">%</span></div><div className="k">of your data uploaded</div></div>
          <div className="kpi"><div className="n">0.83<span className="ci">±.14</span></div><div className="k">deflated, not vanity</div></div>
        </div>
      </header>

      <div className="marq"><div className="track">
        {[0, 1].map((k) => (
          <span key={k}>
            {["Deflated Sharpe", "Walk-forward", "Purged CV", "Triple-barrier", "Meta-labeling", "HRP", "Regime HMM", "Monte Carlo", "Options Greeks", "Macro yields", "World map"].map((t) => (
              <span key={t}>{t}<span className="s"> / </span></span>
            ))}
          </span>
        ))}
      </div></div>

      {/* [01] HONEST */}
      <section className="block" id="honest">
        <div className="split">
          <div>
            <div className="ey"><span className="br">[01]</span> The difference</div>
            <h2 className="reveal">Most tools flatter you.<br />This one won't.</h2>
            <p className="lead reveal d1">We deflate every Sharpe for how many strategies were tried, test out of sample, and show the real registry — <b style={{ color: "var(--text)" }}>including the ones we buried</b>. If an edge isn't real, the numbers say so. That's the whole product.</p>
            <p className="lead reveal d2 m" style={{ fontSize: 13, color: "var(--faint)", marginTop: 14 }}>// every figure ships against its baseline, deflated and out-of-sample.</p>
          </div>
          <div className="track-tbl brk reveal d1">
            <div className="cap"><span>Live registry · real strategies</span><span>the losers included</span></div>
            {STRATS.map((s) => (
              <div className="tr" key={s.name}>
                <b>{s.name}</b>
                <span className={"num" + (s.grave ? " dim" : "")}>{s.sharpe}</span>
                <span className={"num" + (s.grave ? " dim" : "")}>{s.dd}</span>
                <span className={"v" + (s.grave ? " grave" : "")}>{s.status}</span>
              </div>
            ))}
            <div className="foot">↳ backtest Sharpe shown · deflated & walk-forward before anything is trusted.</div>
          </div>
        </div>
      </section>

      {/* [02] DESK — real screenshots */}
      <section className="block" id="desk">
        <div className="ey reveal"><span className="br">[02]</span> The desk institutions have</div>
        <h2 className="reveal d1" style={{ marginBottom: 32 }}>This is the real thing.</h2>
        <div className="shots reveal d2">
          <div className="shot big brk">
            <img src="/shots/regimes.jpg" alt="Market regimes — Hidden Markov Model, SPY price coloured by regime" loading="lazy" />
            <div className="cap"><b>Market regimes</b><span>Hidden Markov Model</span></div>
          </div>
          <div className="shot">
            <img src="/shots/map.jpg" alt="Live world map — ships, flights, cables, conflict and instability signals" loading="lazy" />
            <div className="cap"><b>Live world map</b><span>alt-data · real-time</span></div>
          </div>
          <div className="shot">
            <img src="/shots/charts.jpg" alt="Charts — candlesticks with indicators" loading="lazy" />
            <div className="cap"><b>Charts</b><span>fast · candlesticks</span></div>
          </div>
        </div>
        <p className="reveal d2 m" style={{ marginTop: 14, fontSize: 11.5, color: "var(--faint)", letterSpacing: ".06em" }}>// actual screens from the live desk · your data stays in your browser</p>
      </section>

      {/* [03] TOOLS */}
      <section className="block" id="tools">
        <div className="ey reveal"><span className="br">[03]</span> Capability ledger</div>
        <h2 className="reveal d1" style={{ marginBottom: 30 }}>The tools a quant actually uses.</h2>
        <div className="ledger brk reveal d2">
          {[
            ["[ BACKTEST ]", "Deflated Sharpe · walk-forward · purged cross-validation", "rigorous"],
            ["[ ML ]", "Triple-barrier labels · meta-labeling · hierarchical risk parity", "in-browser"],
            ["[ MARKETS ]", "Charts · screener · options Greeks · Monte-Carlo cones", "live"],
            ["[ MACRO ]", "Yield curves · HMM regime model · correlation structure", "live"],
            ["[ MAP ]", "Ships · flights · quakes · undersea cables · breaking news", "real-time"],
            ["[ PRIVACY ]", "Runs client-side · positions never leave your device", "by default"],
          ].map(([tag, desc, st]) => (
            <div className="lr" key={tag}><span className="tagc">{tag}</span><span className="desc">{desc}</span><span className="st">{st}</span></div>
          ))}
        </div>
      </section>

      {/* manifesto */}
      <section className="block">
        <div className="manifesto reveal">
          <p>“Every metric on this desk is shown against its baseline — the winners and the losers. If it doesn't survive deflation, walk-forward and a real sample, it doesn't ship.”</p>
          <div className="sig">— Built by an independent quant · <b>MMMXCIX</b> · no fund, no affiliation, no incentive to flatter</div>
        </div>
      </section>

      {/* [04] FAQ + CTA */}
      <section className="block" id="faq">
        <div className="ey reveal"><span className="br">[04]</span> Access</div>
        <h2 className="reveal d1" style={{ marginBottom: 26 }}>Questions, answered honestly.</h2>
        <div className="faq reveal d2">
          {FAQ.map(([q, a], i) => (
            <details key={q} open={i === 0}>
              <summary>{q} <span className="pl">+</span></summary>
              <div className="a">{a}</div>
            </details>
          ))}
        </div>
        <div className="cta reveal d2" style={{ marginTop: 44 }}>
          <div className="ey" style={{ justifyContent: "center", color: "var(--pew-hi)" }}><span className="br">//</span> Ready when you are</div>
          <h2>A quant desk in your browser.</h2>
          <p className="lead">Free while in alpha. No sign-up to look around. The honest numbers are waiting.</p>
          <div className="row"><Link className="btn btn-p" to="/">Enter MMMXCIX Quant →</Link><Link className="btn btn-g" to="/pricing">See pricing</Link></div>
        </div>
      </section>

      <footer>
        <Link className="brand" to="/"><Mark size={22} /><span style={{ fontWeight: 800, fontSize: 14 }}>Quant</span></Link>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}><Link to="/pricing">PRICING</Link><Link to="/about">ABOUT</Link><Link to="/changelog">CHANGELOG</Link><Link to="/nutzung">TERMS</Link><Link to="/datenschutz">PRIVACY</Link><Link to="/impressum">IMPRINT</Link></div>
        <span>EDUCATIONAL · NOT INVESTMENT ADVICE · HYPOTHETICAL RESULTS GUARANTEE NOTHING</span>
      </footer>
    </div>
  );
}
