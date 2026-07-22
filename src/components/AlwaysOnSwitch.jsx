import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// The Cortex Always-On switch, Apple style. ON = the research agent hunts,
// builds and improves around the clock (~every 30 min, bounded by the
// seen-filter and LLM caps); OFF = night runs only (~every 20 h). The flag
// lives in KV; the PC agent reads it each 15-min cycle, so a flip takes
// effect within one cycle. Renders inside the RequireAdmin-guarded Cortex hub.
export default function AlwaysOnSwitch() {
  const [on, setOn] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/lab?what=mode")
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => { if (alive) setOn(!!out?.mode?.alwaysOn); })
      .catch(() => { if (alive) setOn(false); });
    return () => { alive = false; };
  }, []);

  const toggle = async () => {
    if (busy || on === null) return;
    const next = !on;
    setOn(next); // optimistic — revert below on failure
    setBusy(true);
    try {
      const res = await fetch("/api/lab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: { alwaysOn: next } }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <label
      className="flex cursor-pointer select-none items-center gap-2.5"
      title="ON: Cortex researches, builds and improves around the clock. OFF: night runs only."
    >
      <span className="text-right leading-tight">
        <span className="block text-xs font-medium text-text">Always-on</span>
        <span className="block text-[10px] text-dim">
          {on === null ? "…" : on ? "around the clock" : "night runs only"}
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={!!on}
        aria-label="Cortex always-on"
        onClick={toggle}
        disabled={on === null || busy}
        className={cn(
          "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors duration-200",
          on ? "bg-up" : "bg-line",
          (on === null || busy) && "opacity-60"
        )}
      >
        <span
          className={cn(
            "absolute left-[2px] top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow-md transition-transform duration-200 ease-out",
            on && "translate-x-[18px]"
          )}
        />
      </button>
    </label>
  );
}
