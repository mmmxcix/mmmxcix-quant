import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useSession, isAdmin } from "@/lib/authClient";

// The fleet switch, same shape as the Cortex Always-On one. ON = the agents on
// the dev machine run; OFF = everything stops, so the GPU and the CPU are free
// for whatever else that machine is doing.
//
// DEV ONLY. /arena is a public page, so unlike AlwaysOnSwitch — which sits
// inside a RequireAdmin route and can assume the guard — this checks the
// session itself and renders nothing for everyone else. Writing is gated on the
// server too; hiding a control is not a permission.
//
// The state shown is what the DAEMON last reported, not what was last clicked:
// the same fleet can be paused by a local double-click, and a switch that shows
// intent rather than reality is worse than no switch.
export default function FleetSwitch() {
  const { data: session } = useSession();
  const admin = isAdmin(session);
  const [control, setControl] = useState(null);   // null = loading
  const [seenAt, setSeenAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!admin) return undefined;
    let alive = true;
    const load = () => fetch("/api/arena?what=control")
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => {
        if (!alive || !out) return;
        setControl(out.control || { paused: false });
        setSeenAt(out.agentSeenAt || 0);
      })
      .catch(() => { if (alive) setControl({ paused: false }); });
    load();
    const t = setInterval(load, 15000);   // reflect a local toggle without a reload
    return () => { alive = false; clearInterval(t); };
  }, [admin]);

  if (!admin) return null;

  const on = control ? !control.paused : null;   // ON = running
  const stale = seenAt > 0 && Date.now() - seenAt > 5 * 60_000;

  const toggle = async () => {
    if (busy || on === null) return;
    const next = !on;
    setControl({ ...control, paused: !next });   // optimistic
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch("/api/arena", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ control: { paused: !next } }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setControl({ ...control, paused: on ? false : true });  // revert
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <label
      className="flex cursor-pointer select-none items-center gap-2.5"
      title="ON: the agents on the dev machine run. OFF: everything stops — no Kronos on the GPU, no compiles, no pollers. Takes effect within ~30s."
    >
      <span className="text-right leading-tight">
        <span className="block text-xs font-medium text-text">Agents</span>
        <span className={cn("block text-[10px]", failed ? "text-down" : "text-dim")}>
          {failed ? "could not reach the site"
            : on === null ? "…"
            : !on ? "paused"
            : stale ? "running · agent silent" : "running"}
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={!!on}
        aria-label="Local agent fleet"
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
