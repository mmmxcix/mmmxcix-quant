import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

// Global quick-nav for a keyboard-first power user (the "Alex" persona in the
// design critique): ⌘K / Ctrl-K anywhere opens a fuzzy jump list over every
// destination. Also opens on an `open-command-palette` event so an on-screen
// button can trigger it for mouse/touch users. Rendered once, at the Layout root
// (outside any scroll container) so the dialog is never clipped.

const COMMANDS = [
  { label: "Dashboard", to: "/", group: "Markets" },
  { label: "Charts", to: "/charts", group: "Markets" },
  { label: "Screener", to: "/screener", group: "Markets" },
  { label: "Correlation Matrix", to: "/screener/correlation", group: "Markets" },
  { label: "News", to: "/news", group: "Markets" },
  { label: "Macro · Bond Yields", to: "/macro/yields", group: "Markets" },
  { label: "Macro · Econ Events", to: "/macro/calendar", group: "Markets" },
  { label: "Macro · L3 Archive", to: "/macro/l3", group: "Markets" },
  { label: "World Map", to: "/map", group: "Markets" },
  { label: "Backtest", to: "/backtest", group: "Strategy" },
  { label: "ML Studio", to: "/backtest/ml", group: "Strategy" },
  { label: "Event Lab", to: "/backtest/events", group: "Strategy" },
  { label: "Regimes", to: "/regimes", group: "Strategy" },
  { label: "Portfolio", to: "/portfolio", group: "Strategy" },
  { label: "Tools", to: "/tools", group: "Strategy" },
  { label: "Cortex · Registry", to: "/cortex/registry", group: "Cortex" },
  { label: "Cortex · Paper", to: "/cortex/paper", group: "Cortex" },
  { label: "Cortex · RiskGate", to: "/cortex/riskgate", group: "Cortex" },
  { label: "Cortex · Brain Vault", to: "/cortex/brain", group: "Cortex" },
  { label: "Academy", to: "/learn", group: "Learn" },
  { label: "Formula Reference", to: "/learn/formulas", group: "Learn" },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) { setQ(""); setSel(0); requestAnimationFrame(() => inputRef.current?.focus()); }
  }, [open]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return COMMANDS;
    return COMMANDS.filter((c) => `${c.label} ${c.group}`.toLowerCase().includes(s));
  }, [q]);

  useEffect(() => { setSel(0); }, [q]);

  if (!open) return null;

  const go = (c) => { if (!c) return; setOpen(false); navigate(c.to); };

  const onKeyDown = (e) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); go(results[sel]); }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-xl border border-line lg-glass shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Jump to…  (type a page)"
          aria-label="Search pages"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-text outline-none placeholder:text-dim/60"
        />
        <ul className="max-h-72 overflow-y-auto py-1">
          {results.length === 0 && <li className="px-4 py-3 text-sm text-dim">No matches.</li>}
          {results.map((c, i) => (
            <li key={c.to}>
              <button
                onClick={() => go(c)}
                onMouseMove={() => setSel(i)}
                className={cn(
                  "flex w-full items-center justify-between px-4 py-2 text-left text-sm transition-colors",
                  i === sel ? "bg-accent/10 text-accent" : "text-text hover:bg-surface"
                )}
              >
                <span>{c.label}</span>
                <span className="text-[10px] uppercase tracking-wide text-dim">{c.group}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[10px] text-dim">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
