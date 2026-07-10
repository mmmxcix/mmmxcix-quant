import { useEffect, useMemo, useState } from "react";
import { Globe, ArrowRight } from "lucide-react";
import { MARKET_CLOCKS, marketStatus, fmtCountdown, nextEvent } from "@/lib/marketHours";
import { cn } from "@/lib/utils";

// World clock: one live, DST-correct clock per market with open/close status,
// countdown to the next transition, and a "what happens next" summary. Ticks
// once per second, aligned to the wall-clock second.

const pad = (n) => String(n).padStart(2, "0");

// Small analog clock face driven by the market's local time.
function AnalogClock({ hour, minute, second, active }) {
  const size = 44, c = size / 2, r = c - 2;
  const hand = (angleDeg, length, width, color) => {
    const a = ((angleDeg - 90) * Math.PI) / 180;
    return (
      <line
        x1={c} y1={c}
        x2={c + Math.cos(a) * length} y2={c + Math.sin(a) * length}
        stroke={color} strokeWidth={width} strokeLinecap="round"
      />
    );
  };
  const hourA = ((hour % 12) + minute / 60) * 30;
  const minA = (minute + second / 60) * 6;
  const secA = second * 6;
  const ink = active ? "#e2e8f0" : "#64748b";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={c} cy={c} r={r} fill={active ? "#10b98114" : "#0b101800"} stroke={active ? "#10b98155" : "#1e293b"} strokeWidth="1.5" />
      {[0, 90, 180, 270].map((a) => {
        const rad = ((a - 90) * Math.PI) / 180;
        return (
          <line key={a}
            x1={c + Math.cos(rad) * (r - 3)} y1={c + Math.sin(rad) * (r - 3)}
            x2={c + Math.cos(rad) * (r - 1)} y2={c + Math.sin(rad) * (r - 1)}
            stroke="#475569" strokeWidth="1.5"
          />
        );
      })}
      {hand(hourA, r * 0.5, 2.4, ink)}
      {hand(minA, r * 0.74, 1.8, ink)}
      {hand(secA, r * 0.82, 0.9, "#2dd4bf")}
      <circle cx={c} cy={c} r="1.6" fill="#2dd4bf" />
    </svg>
  );
}

function StatusBadge({ phase, breakLabel }) {
  if (phase === "open") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-up/15 border border-up/40 px-2 py-0.5 text-[10px] font-semibold text-up uppercase tracking-wide">
        <span className="relative flex w-1.5 h-1.5">
          <span className="animate-ping absolute inline-flex w-full h-full rounded-full bg-up opacity-60" />
          <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-up" />
        </span>
        Open
      </span>
    );
  }
  if (phase === "break") {
    return (
      <span className="rounded-full bg-yellow-500/15 border border-yellow-500/40 px-2 py-0.5 text-[10px] font-semibold text-yellow-400 uppercase tracking-wide">
        {breakLabel || "Break"}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-bg border border-line px-2 py-0.5 text-[10px] font-semibold text-dim uppercase tracking-wide">
      Closed
    </span>
  );
}

export default function WorldClock() {
  const [now, setNow] = useState(() => new Date());

  // Tick aligned to the real second boundary so all clocks flip together.
  useEffect(() => {
    let interval;
    const align = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 1000);
    }, 1000 - (Date.now() % 1000));
    return () => { clearTimeout(align); clearInterval(interval); };
  }, []);

  const statuses = useMemo(
    () => MARKET_CLOCKS.map((market) => ({ market, status: marketStatus(market, now) })),
    [now]
  );
  const openCount = statuses.filter((s) => s.status.phase === "open").length;
  const next = nextEvent(statuses);

  return (
    <div className="rounded-xl border border-line lg-glass p-5">
      {/* Header: your time + what happens next */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold">World market clock</h2>
          <span className="text-xs text-dim">
            · your time{" "}
            <span className="font-mono text-text">
              {pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-dim">
            <span className="font-mono text-up">{openCount}</span> of {MARKET_CLOCKS.length} open
          </span>
          {next && (
            <span className="flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/5 px-2.5 py-1 text-accent">
              <ArrowRight className="w-3 h-3" />
              next: {next.market.city} {next.action} in {fmtCountdown(next.mins)}
            </span>
          )}
        </div>
      </div>

      {/* Market grid */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {statuses.map(({ market, status }) => {
          const { parts, phase } = status;
          const active = phase === "open";
          return (
            <div key={market.id}
              className={cn("flex gap-3 rounded-lg border p-3 transition-colors",
                active ? "border-up/30 bg-up/[0.04]" : "border-line bg-bg/30")}>
              <AnalogClock hour={parts.hour} minute={parts.minute} second={parts.second} active={active} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-text truncate">
                    <span className="mr-1">{market.flag}</span>{market.city}
                  </p>
                  <StatusBadge phase={phase} breakLabel={market.breakLabel} />
                </div>
                <p className="text-[10px] text-dim truncate">{market.exchange}</p>
                <p className="font-mono text-base text-text mt-0.5">
                  {pad(parts.hour)}:{pad(parts.minute)}
                  <span className="text-dim text-xs">:{pad(parts.second)}</span>
                </p>
                <p className="text-[11px] mt-0.5">
                  {market.alwaysOpen ? (
                    <span className="text-up">always open — 24/7</span>
                  ) : phase === "open" ? (
                    <span className="text-dim">closes in <span className="text-text font-mono">{fmtCountdown(status.minsToClose)}</span></span>
                  ) : phase === "break" ? (
                    <span className="text-dim">reopens in <span className="text-yellow-400 font-mono">{fmtCountdown(status.minsToOpen)}</span></span>
                  ) : (
                    <span className="text-dim">
                      opens {status.nextOpenDay ? `${status.nextOpenDay} ` : ""}in{" "}
                      <span className="text-text font-mono">{fmtCountdown(status.minsToOpen)}</span>
                    </span>
                  )}
                </p>
                {active && status.sessionProgress !== null && (
                  <div className="h-1 rounded-full bg-bg overflow-hidden mt-1.5">
                    <div className="h-full bg-up/60" style={{ width: `${Math.round(status.sessionProgress * 100)}%` }} />
                  </div>
                )}
                <p className="text-[10px] text-dim/70 font-mono mt-1 truncate">{market.hoursLabel} local</p>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-dim/70 mt-3">
        Times come from your device clock via each exchange's real time zone (daylight saving handled automatically).
        Regular sessions only — exchange holidays and half days are not tracked.
      </p>
    </div>
  );
}
