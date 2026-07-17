import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Network, RefreshCw, BookOpenCheck, Skull } from "lucide-react";
import { cn } from "@/lib/utils";

// Brain Vault — the knowledge graph the research agent builds as it reads.
// Nodes = papers (green = survived the gauntlet, red = buried); edges connect
// papers that share a research topic. Data is pushed by scripts/research-agent
// from MULTIPLE sources (arXiv + OpenAlex) to /api/lab (channel lab:brain).
// Self-contained canvas force simulation — no external graph library.

const TOKEN_KEY = "quant_dev_token";
const COLORS = { candidate: "#34d399", graveyard: "#f87171", edge: "rgba(148,163,184,0.18)" };

export default function BrainVault() {
  const [data, setData] = useState(undefined); // undefined=loading, null=none
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(null);
  const token = (() => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } })();

  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const simRef = useRef(null); // { nodes, edges, raf }

  const load = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/lab?what=brain", { headers: { "x-lab-token": token } });
      const out = await res.json();
      setData(res.ok ? (out.brain ?? null) : null);
    } catch { setData(null); } finally { setBusy(false); }
  };
  useEffect(() => { if (token) load(); else setData(null); /* eslint-disable-next-line */ }, []);

  // ── force simulation ──────────────────────────────────────────────────────
  useEffect(() => {
    const graph = data;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!graph?.nodes?.length || !canvas || !wrap) return;

    let W = wrap.clientWidth, H = 520;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const setup = () => {
      W = wrap.clientWidth;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
    };
    setup();
    const ctx = canvas.getContext("2d");

    // init node positions in a loose disc around the centre
    const nodes = graph.nodes.map((n, i) => {
      const a = (i / graph.nodes.length) * Math.PI * 2;
      const r = 40 + Math.random() * Math.min(W, H) * 0.35;
      return { ...n, x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0,
        rad: n.outcome === "candidate" ? 6.5 : 3.5 };
    });
    const edges = (graph.edges || []).filter((e) => nodes[e.a] && nodes[e.b]);
    simRef.current = { nodes, edges };

    let alpha = 1;
    const REST = 64, REPULSION = 1400;
    const step = () => {
      // repulsion (O(n²) — fine for ≤120 nodes)
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = (REPULSION / d2) * alpha;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      // springs along edges
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - REST) * 0.02 * alpha;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      // gravity to centre + integrate
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.0016 * alpha;
        n.vy += (H / 2 - n.y) * 0.0016 * alpha;
        n.vx *= 0.86; n.vy *= 0.86;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(8, Math.min(W - 8, n.x));
        n.y = Math.max(8, Math.min(H - 8, n.y));
      }
      alpha *= 0.99;
      draw();
      if (alpha > 0.02) simRef.current.raf = requestAnimationFrame(step);
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // edges
      ctx.strokeStyle = COLORS.edge; ctx.lineWidth = 1;
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b];
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      // nodes
      for (const n of nodes) {
        const c = COLORS[n.outcome] || "#94a3b8";
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.rad, 0, Math.PI * 2);
        ctx.fillStyle = c;
        ctx.globalAlpha = n.outcome === "graveyard" ? 0.55 : 1;
        ctx.fill();
        if (n.outcome === "candidate") { // glow for survivors
          ctx.globalAlpha = 0.25; ctx.beginPath();
          ctx.arc(n.x, n.y, n.rad + 4, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    };

    cancelAnimationFrame(simRef.current.raf);
    simRef.current.raf = requestAnimationFrame(step);

    const onResize = () => { setup(); alpha = Math.max(alpha, 0.3); cancelAnimationFrame(simRef.current.raf); simRef.current.raf = requestAnimationFrame(step); };
    const ro = new ResizeObserver(onResize);
    ro.observe(wrap);

    const onMove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      let best = null, bd = 12 * 12;
      for (const n of nodes) {
        const dx = n.x - mx, dy = n.y - my, d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; best = n; }
      }
      setHover(best ? { n: best, x: mx, y: my } : null);
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", () => setHover(null));

    return () => {
      cancelAnimationFrame(simRef.current?.raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
    };
  }, [data]);

  const stats = data?.stats;
  const sources = data?.sources || {};

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Cortex</p>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-2xl font-bold">Brain Vault</h1>
        <Network className="w-5 h-5 text-accent" />
        <button onClick={load} disabled={busy || !token}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-dim hover:text-text disabled:opacity-50">
          <RefreshCw className={cn("w-3.5 h-3.5", busy && "animate-spin")} /> Refresh
        </button>
      </div>

      {!token && (
        <div className="rounded-xl border border-line lg-glass p-5 text-sm text-dim">
          The Brain Vault is private. Set the dev token on the <Link to="/coach" className="text-accent underline">Coach</Link> page to view it.
        </div>
      )}

      {token && data === null && (
        <div className="rounded-xl border border-line lg-glass p-5 text-sm text-dim">
          No knowledge graph yet — the research agent hasn't reported. Once <code className="text-text">research-agent.mjs</code> runs, every paper it reads becomes a node here, linked by shared topic.
        </div>
      )}

      {token && data?.nodes?.length > 0 && (
        <div className="space-y-4">
          {/* stat strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Papers read" value={stats?.papersRead ?? "—"} />
            <Stat label="Survivors" value={stats?.candidates ?? 0} color="text-up" />
            <Stat label="Buried" value={stats?.graveyard ?? 0} color="text-down" />
            <Stat label="Sources" value={Object.keys(sources).length || 1} />
          </div>

          {/* graph */}
          <div ref={wrapRef} className="relative rounded-xl border border-line lg-glass overflow-hidden">
            <canvas ref={canvasRef} className="block w-full" style={{ height: 520 }} />
            {/* legend */}
            <div className="absolute top-3 left-3 flex flex-col gap-1 text-[11px] text-dim">
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full inline-block" style={{ background: COLORS.candidate }} /> survivor (candidate)</span>
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full inline-block opacity-60" style={{ background: COLORS.graveyard }} /> buried</span>
              <span className="text-dim/60">edge = shared research topic</span>
            </div>
            {/* source counts */}
            <div className="absolute bottom-3 right-3 flex gap-3 text-[11px] text-dim">
              {Object.entries(sources).map(([s, n]) => (
                <span key={s}>{s}: <span className="text-text font-mono">{n}</span></span>
              ))}
            </div>
            {/* hover tooltip */}
            {hover && (
              <div className="pointer-events-none absolute z-10 max-w-[260px] rounded-lg border border-line bg-bg/95 p-2.5 text-xs shadow-xl"
                style={{ left: Math.min(hover.x + 12, (wrapRef.current?.clientWidth || 400) - 270), top: hover.y + 12 }}>
                <div className="flex items-center gap-1.5 mb-1">
                  {hover.n.outcome === "candidate"
                    ? <BookOpenCheck className="w-3.5 h-3.5 text-up shrink-0" />
                    : <Skull className="w-3.5 h-3.5 text-down shrink-0" />}
                  <span className="font-medium leading-tight">{hover.n.label}</span>
                </div>
                <div className="text-dim space-y-0.5">
                  <p>{hover.n.source} · {hover.n.outcome === "candidate" ? `DSR ${hover.n.dsr}%` : (hover.n.reason || "buried")}</p>
                  {hover.n.topics?.length > 0 && <p className="text-dim/70">{hover.n.topics.join(" · ")}</p>}
                </div>
              </div>
            )}
          </div>

          <p className="text-[11px] text-dim/70 leading-relaxed">
            Every paper the agent reads — from arXiv and OpenAlex — lands here. Survivors (green) cleared the full
            validation gauntlet; buried nodes (red) failed and are kept as a record. Hover a node for its source,
            verdict and topics — every paper the research agent has read, built from our own honest data.
          </p>
        </div>
      )}

      {token && data?.nodes?.length === 0 && (
        <div className="rounded-xl border border-line lg-glass p-5 text-sm text-dim">
          The agent has reported, but no papers are graphed yet. Give it a run or two.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="rounded-xl border border-line lg-glass p-3">
      <p className="text-[10px] text-dim uppercase tracking-wide mb-0.5">{label}</p>
      <p className={cn("text-xl font-bold font-mono", color)}>{value}</p>
    </div>
  );
}
