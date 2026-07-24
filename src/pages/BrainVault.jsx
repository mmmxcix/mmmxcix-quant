import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Network, RefreshCw, BookOpenCheck, Skull } from "lucide-react";
import { cn } from "@/lib/utils";

// Brain Vault — the knowledge graph the research agent builds as it reads.
// Nodes = papers (green = survived the gauntlet, red = buried); edges connect
// papers that share a research topic. Data is pushed by scripts/research-agent
// from MULTIPLE sources (arXiv + OpenAlex) to /api/lab (channel lab:brain).
// Self-contained canvas force simulation — no external graph library.

const COLORS = { candidate: "#34d399", graveyard: "#f87171", edge: "rgba(148,163,184,0.18)" };

export default function BrainVault() {
  const [data, setData] = useState(undefined); // undefined=loading, null=none
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(null);

  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const simRef = useRef(null); // { nodes, edges, raf }
  const viewRef = useRef(null); // { reset } — re-frame the camera on demand

  // Auth = the admin session cookie (this page only renders inside the
  // RequireAdmin-guarded Cortex hub anyway).
  const load = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/lab?what=brain");
      const out = await res.json();
      setData(res.ok ? (out.brain ?? null) : null);
    } catch { setData(null); } finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // ── force simulation + free pan/zoom camera (Obsidian-style) ───────────────
  useEffect(() => {
    const graph = data;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!graph?.nodes?.length || !canvas || !wrap) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let W = wrap.clientWidth;
    let H = Math.min(760, Math.max(460, Math.round(window.innerHeight * 0.66)));
    const setup = () => {
      W = wrap.clientWidth;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
    };
    setup();
    const ctx = canvas.getContext("2d");

    // Nodes live in WORLD space around the origin and are NOT clamped to the
    // viewport — the camera pans/zooms over them, so the graph can spread out
    // instead of being squeezed into the panel (the whole point of this view).
    const nodes = graph.nodes.map((n, i) => {
      const a = (i / graph.nodes.length) * Math.PI * 2;
      const r = 40 + Math.random() * 260;
      return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0,
        rad: n.outcome === "candidate" ? 6.5 : 3.5 };
    });
    const edges = (graph.edges || []).filter((e) => nodes[e.a] && nodes[e.b]);
    simRef.current = { nodes, edges };

    // Camera: screen = world * scale + (tx, ty). Starts framed on the origin.
    const cam = { scale: 1, tx: W / 2, ty: H / 2 };
    let userMoved = false; // once the user grabs the view, stop auto-framing

    const fit = () => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
      const pad = 70, gw = (maxX - minX) || 1, gh = (maxY - minY) || 1;
      cam.scale = Math.max(0.15, Math.min((W - pad * 2) / gw, (H - pad * 2) / gh, 1.4));
      cam.tx = W / 2 - ((minX + maxX) / 2) * cam.scale;
      cam.ty = H / 2 - ((minY + maxY) / 2) * cam.scale;
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(cam.tx, cam.ty);
      ctx.scale(cam.scale, cam.scale);
      ctx.strokeStyle = COLORS.edge; ctx.lineWidth = 1 / cam.scale;
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b];
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      for (const n of nodes) {
        const c = COLORS[n.outcome] || "#94a3b8";
        ctx.beginPath(); ctx.arc(n.x, n.y, n.rad, 0, Math.PI * 2);
        ctx.fillStyle = c; ctx.globalAlpha = n.outcome === "graveyard" ? 0.55 : 1; ctx.fill();
        if (n.outcome === "candidate") { ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(n.x, n.y, n.rad + 4, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill(); }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    };

    let alpha = 1;
    const REST = 64, REPULSION = 1400;
    const step = () => {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = (REPULSION / d2) * alpha, d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      for (const e of edges) {
        const a = nodes[e.a], b = nodes[e.b];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - REST) * 0.02 * alpha, fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      for (const n of nodes) {
        if (n.pinned) { n.vx = 0; n.vy = 0; continue; } // held by the cursor
        n.vx += (0 - n.x) * 0.0016 * alpha;   // gravity toward the world origin
        n.vy += (0 - n.y) * 0.0016 * alpha;
        n.vx *= 0.86; n.vy *= 0.86;
        n.x += n.vx; n.y += n.vy;               // no viewport clamping
      }
      alpha *= 0.99;
      if (!userMoved) fit();                    // keep the whole graph framed while it settles
      draw();
      if (alpha > 0.02) simRef.current.raf = requestAnimationFrame(step);
    };

    cancelAnimationFrame(simRef.current.raf);
    simRef.current.raf = requestAnimationFrame(step);
    viewRef.current = { reset: () => { userMoved = false; fit(); draw(); } };

    const onResize = () => { setup(); if (!userMoved) fit(); alpha = Math.max(alpha, 0.25); cancelAnimationFrame(simRef.current.raf); simRef.current.raf = requestAnimationFrame(step); };
    const ro = new ResizeObserver(onResize);
    ro.observe(wrap);

    // ── interaction: drag NODES (elastic, Obsidian-style) or pan; wheel zooms ─
    let dragging = false, lastX = 0, lastY = 0, dragNode = null;
    const hitTest = (mx, my) => {
      const wx = (mx - cam.tx) / cam.scale, wy = (my - cam.ty) / cam.scale;
      let best = null, bd = (12 / cam.scale) ** 2;
      for (const n of nodes) { const dx = n.x - wx, dy = n.y - wy, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = n; } }
      return best;
    };
    // Re-heat the simulation and make sure the RAF loop is alive — this is what
    // makes neighbours get PULLED along by the springs while you drag, and the
    // whole cluster wobble back into place when you let go.
    const kick = (a) => {
      alpha = Math.max(alpha, a);
      cancelAnimationFrame(simRef.current.raf);
      simRef.current.raf = requestAnimationFrame(step);
    };
    const onDown = (e) => {
      const rect = canvas.getBoundingClientRect();
      const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
      userMoved = true;
      if (hit) {
        dragNode = hit; hit.pinned = true;
        setHover(null);
        canvas.style.cursor = "grabbing";
        kick(0.5);
      } else {
        dragging = true; lastX = e.clientX; lastY = e.clientY;
        canvas.style.cursor = "grabbing";
      }
    };
    const onUp = () => {
      if (dragNode) { dragNode.pinned = false; dragNode = null; kick(0.3); } // release → elastic settle
      dragging = false;
      canvas.style.cursor = "grab";
    };
    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (dragNode) {
        dragNode.x = (mx - cam.tx) / cam.scale;
        dragNode.y = (my - cam.ty) / cam.scale;
        dragNode.vx = 0; dragNode.vy = 0;
        kick(0.35); // keep the springs live while dragging
        return;     // the running sim draws every frame
      }
      if (dragging) {
        cam.tx += e.clientX - lastX; cam.ty += e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        setHover(null); draw(); return;
      }
      const best = hitTest(mx, my);
      canvas.style.cursor = best ? "pointer" : "grab";
      setHover(best ? { n: best, x: mx, y: my } : null);
    };
    const onLeave = () => { if (!dragging) setHover(null); };
    const onWheel = (e) => {
      e.preventDefault();
      userMoved = true;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const wx = (mx - cam.tx) / cam.scale, wy = (my - cam.ty) / cam.scale;
      cam.scale = Math.max(0.1, Math.min(4, cam.scale * Math.exp(-e.deltaY * 0.0015)));
      cam.tx = mx - wx * cam.scale; cam.ty = my - wy * cam.scale;
      draw();
    };
    let tLast = null;
    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const hit = hitTest(t.clientX - rect.left, t.clientY - rect.top);
      userMoved = true;
      if (hit) { dragNode = hit; hit.pinned = true; setHover(null); kick(0.5); }
      else tLast = { x: t.clientX, y: t.clientY };
    };
    const onTouchMove = (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (dragNode) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        dragNode.x = (t.clientX - rect.left - cam.tx) / cam.scale;
        dragNode.y = (t.clientY - rect.top - cam.ty) / cam.scale;
        dragNode.vx = 0; dragNode.vy = 0;
        kick(0.35);
        return;
      }
      if (tLast) { e.preventDefault(); cam.tx += t.clientX - tLast.x; cam.ty += t.clientY - tLast.y; tLast = { x: t.clientX, y: t.clientY }; draw(); }
    };
    const onTouchEnd = () => {
      if (dragNode) { dragNode.pinned = false; dragNode = null; kick(0.3); }
      tLast = null;
    };

    canvas.style.cursor = "grab";
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);

    return () => {
      cancelAnimationFrame(simRef.current?.raf);
      ro.disconnect();
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
    };
  }, [data]);

  const stats = data?.stats;
  const sources = data?.sources || {};

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-2xl font-bold">Brain Vault</h1>
        <Network className="w-5 h-5 text-accent" />
        <button onClick={load} disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs text-dim hover:text-text disabled:opacity-50">
          <RefreshCw className={cn("w-3.5 h-3.5", busy && "animate-spin")} /> Refresh
        </button>
      </div>

      {data === null && (
        <div className="rounded-xl border border-line lg-glass p-5 text-sm text-dim">
          No knowledge graph yet — the research agent hasn't reported. Once <code className="text-text">research-agent.mjs</code> runs, every paper it reads becomes a node here, linked by shared topic.
        </div>
      )}

      {data?.nodes?.length > 0 && (
        <div className="space-y-4">
          {/* stat strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 stagger">
            <Stat label="Papers read" value={stats?.papersRead ?? "—"} />
            <Stat label="Survivors" value={stats?.candidates ?? 0} color="text-up" />
            <Stat label="Buried" value={stats?.graveyard ?? 0} color="text-down" />
            <Stat label="Sources" value={Object.keys(sources).length || 1} />
          </div>

          {/* graph */}
          <div ref={wrapRef} className="relative rounded-xl border border-line lg-glass overflow-hidden">
            <canvas ref={canvasRef} className="block w-full touch-none" style={{ height: 520 }} />
            {/* legend */}
            <div className="absolute top-3 left-3 flex flex-col gap-1 text-[11px] text-dim">
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full inline-block" style={{ background: COLORS.candidate }} /> survivor (candidate)</span>
              <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full inline-block opacity-60" style={{ background: COLORS.graveyard }} /> buried</span>
              <span className="text-dim">edge = shared research topic</span>
              <span className="text-dim">scroll = zoom · drag bg = pan · drag node = move it</span>
            </div>
            {/* view controls */}
            <button
              onClick={() => viewRef.current?.reset()}
              className="absolute top-3 right-3 z-10 rounded-lg border border-line bg-bg/80 px-2.5 py-1 text-[11px] text-dim transition-colors hover:text-text"
            >
              Reset view
            </button>
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
                  {hover.n.topics?.length > 0 && <p className="text-dim">{hover.n.topics.join(" · ")}</p>}
                </div>
              </div>
            )}
          </div>

          <p className="text-[11px] text-dim leading-relaxed">
            Every paper the agent reads — from arXiv and OpenAlex — lands here. Survivors (green) cleared the full
            validation gauntlet; buried nodes (red) failed and are kept as a record. Hover a node for its source,
            verdict and topics — every paper the research agent has read, built from our own honest data.
          </p>
        </div>
      )}

      {data?.nodes?.length === 0 && (
        <div className="rounded-xl border border-line lg-glass p-5 text-sm text-dim">
          The agent has reported, but no papers are graphed yet. Give it a run or two.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="rounded-xl border border-line lg-glass p-3 hover-lift">
      <p className="text-[10px] text-dim uppercase tracking-wide mb-0.5">{label}</p>
      <p className={cn("text-xl font-bold font-mono", color)}>{value}</p>
    </div>
  );
}
