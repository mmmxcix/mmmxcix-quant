import { useEffect, useMemo, useState } from "react";
import { Calculator, Scale, Crosshair, Activity, Clock, TrendingUp } from "lucide-react";
import { cn, fmtNum, fmtPct } from "@/lib/utils";

/* ── shared bits ──────────────────────────────────────────────────── */

function ToolCard({ icon: Icon, title, children }) {
  return (
    <div className="rounded-xl border border-line lg-glass p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Field({ label, value, onChange, step = "any", min }) {
  return (
    <label className="text-xs text-dim">
      {label}
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(e) => onChange(e.target.value)}
        className="input-base w-full mt-1 font-mono"
      />
    </label>
  );
}

function ResultRow({ label, value, tone = "text-text" }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-xs text-dim">{label}</span>
      <span className={cn("font-mono text-sm font-semibold", tone)}>{value}</span>
    </div>
  );
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};

/* ── 1. Positionsgrössen-Rechner ──────────────────────────────────── */

function PositionSizeTool() {
  const [account, setAccount] = useState("10000");
  const [riskPct, setRiskPct] = useState("1");
  const [entry, setEntry] = useState("100");
  const [stop, setStop] = useState("95");

  const r = useMemo(() => {
    const acc = num(account), risk = num(riskPct), e = num(entry), s = num(stop);
    if (!(acc > 0) || !(risk > 0) || !(e > 0) || !(s > 0) || e === s) return null;
    const riskAmount = (acc * risk) / 100;
    const dist = Math.abs(e - s);
    const size = riskAmount / dist;
    const posValue = size * e;
    return {
      direction: s < e ? "Long" : "Short",
      riskAmount,
      size,
      posValue,
      leverage: posValue / acc,
    };
  }, [account, riskPct, entry, stop]);

  return (
    <ToolCard icon={Calculator} title="Position size calculator">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Account size" value={account} onChange={setAccount} min="0" />
        <Field label="Risk per trade (%)" value={riskPct} onChange={setRiskPct} min="0" />
        <Field label="Entry" value={entry} onChange={setEntry} min="0" />
        <Field label="Stop-loss" value={stop} onChange={setStop} min="0" />
      </div>
      {r ? (
        <div className="space-y-1.5 pt-1 border-t border-line/60">
          <ResultRow
            label="Direction"
            value={r.direction}
            tone={r.direction === "Long" ? "text-up" : "text-down"}
          />
          <ResultRow label="Risked amount" value={fmtNum(r.riskAmount)} />
          <ResultRow label="Position size (shares/coins)" value={fmtNum(r.size, 4)} tone="text-accent" />
          <ResultRow label="Position value" value={fmtNum(r.posValue)} />
          {r.leverage > 1 && (
            <p className="text-xs text-down pt-1">
              Position value exceeds the account — requires about {fmtNum(r.leverage, 1)}× leverage.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-dim">Enter valid values (Entry ≠ Stop).</p>
      )}
    </ToolCard>
  );
}

/* ── 2. Risk/Reward-Rechner ───────────────────────────────────────── */

function RiskRewardTool() {
  const [entry, setEntry] = useState("100");
  const [stop, setStop] = useState("95");
  const [target, setTarget] = useState("112");

  const r = useMemo(() => {
    const e = num(entry), s = num(stop), t = num(target);
    if (!(e > 0) || !(s > 0) || !(t > 0) || e === s) return null;
    const risk = Math.abs(e - s);
    const reward = Math.abs(t - e);
    const rr = reward / risk;
    return {
      rr,
      lossPct: (risk / e) * 100,
      winPct: (reward / e) * 100,
      breakevenWinrate: (1 / (1 + rr)) * 100,
    };
  }, [entry, stop, target]);

  const rrTone = r ? (r.rr >= 2 ? "text-up" : r.rr >= 1 ? "text-text" : "text-down") : "text-text";

  return (
    <ToolCard icon={Scale} title="Risk/Reward calculator">
      <div className="grid grid-cols-3 gap-2">
        <Field label="Entry" value={entry} onChange={setEntry} min="0" />
        <Field label="Stop" value={stop} onChange={setStop} min="0" />
        <Field label="Target" value={target} onChange={setTarget} min="0" />
      </div>
      {r ? (
        <div className="space-y-1.5 pt-1 border-t border-line/60">
          <ResultRow label="R:R ratio" value={`${fmtNum(r.rr)} : 1`} tone={rrTone} />
          <ResultRow label="Gain distance" value={fmtPct(r.winPct)} tone="text-up" />
          <ResultRow label="Loss distance" value={fmtPct(-r.lossPct)} tone="text-down" />
          <ResultRow label="Break-even win rate" value={`${fmtNum(r.breakevenWinrate, 1)}%`} />
        </div>
      ) : (
        <p className="text-xs text-dim">Enter valid values (Entry ≠ Stop).</p>
      )}
    </ToolCard>
  );
}

/* ── 3. Pivot-Punkte ──────────────────────────────────────────────── */

function PivotTool() {
  const [high, setHigh] = useState("105");
  const [low, setLow] = useState("98");
  const [close, setClose] = useState("102");
  const [method, setMethod] = useState("classic"); // classic | fib

  const rows = useMemo(() => {
    const h = num(high), l = num(low), c = num(close);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || h < l) return null;
    const p = (h + l + c) / 3;
    const range = h - l;
    let levels;
    if (method === "classic") {
      levels = {
        R3: h + 2 * (p - l),
        R2: p + range,
        R1: 2 * p - l,
        P: p,
        S1: 2 * p - h,
        S2: p - range,
        S3: l - 2 * (h - p),
      };
    } else {
      levels = {
        R3: p + 1.0 * range,
        R2: p + 0.618 * range,
        R1: p + 0.382 * range,
        P: p,
        S1: p - 0.382 * range,
        S2: p - 0.618 * range,
        S3: p - 1.0 * range,
      };
    }
    return [
      { key: "R3", tone: "text-down/80" },
      { key: "R2", tone: "text-down/80" },
      { key: "R1", tone: "text-down/80" },
      { key: "P", label: "Pivot", tone: "text-accent" },
      { key: "S1", tone: "text-up/80" },
      { key: "S2", tone: "text-up/80" },
      { key: "S3", tone: "text-up/80" },
    ].map((r) => ({ ...r, value: levels[r.key] }));
  }, [high, low, close, method]);

  return (
    <ToolCard icon={Crosshair} title="Pivot points">
      <div className="grid grid-cols-3 gap-2">
        <Field label="High (prev. period)" value={high} onChange={setHigh} />
        <Field label="Low (prev. period)" value={low} onChange={setLow} />
        <Field label="Close (prev. period)" value={close} onChange={setClose} />
      </div>
      <div className="flex gap-1">
        {[
          { id: "classic", label: "Classic" },
          { id: "fib", label: "Fibonacci" },
        ].map((m) => (
          <button
            key={m.id}
            onClick={() => setMethod(m.id)}
            className={cn("chip", method === m.id ? "chip-active" : "chip-idle")}
          >
            {m.label}
          </button>
        ))}
      </div>
      {rows ? (
        <table className="w-full text-sm font-mono">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-line/40 last:border-0">
                <td className={cn("py-1 text-xs", r.tone)}>{r.label ?? r.key}</td>
                <td className={cn("py-1 text-right font-semibold", r.tone)}>{fmtNum(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-dim">Enter valid values (High ≥ Low).</p>
      )}
    </ToolCard>
  );
}

/* ── 4. ATR-Stop-Rechner ──────────────────────────────────────────── */

function AtrStopTool() {
  const [entry, setEntry] = useState("100");
  const [atr, setAtr] = useState("2.5");
  const [mult, setMult] = useState("2");
  const [dir, setDir] = useState("long"); // long | short

  const r = useMemo(() => {
    const e = num(entry), a = num(atr), m = num(mult);
    if (!(e > 0) || !(a > 0) || !(m > 0)) return null;
    const dist = a * m;
    const sign = dir === "long" ? 1 : -1;
    return {
      stop: e - sign * dist,
      distPct: (dist / e) * 100,
      targets: [1, 2, 3].map((n) => ({ n, level: e + sign * n * dist })),
    };
  }, [entry, atr, mult, dir]);

  return (
    <ToolCard icon={Activity} title="ATR stop calculator">
      <div className="grid grid-cols-3 gap-2">
        <Field label="Entry" value={entry} onChange={setEntry} min="0" />
        <Field label="ATR value" value={atr} onChange={setAtr} min="0" />
        <Field label="Multiplier" value={mult} onChange={setMult} min="0" />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {["1.5", "2", "3"].map((m) => (
          <button
            key={m}
            onClick={() => setMult(m)}
            className={cn("chip font-mono", mult === m ? "chip-active" : "chip-idle")}
          >
            {m}×
          </button>
        ))}
        <span className="w-px h-4 bg-line mx-1" />
        {[
          { id: "long", label: "Long" },
          { id: "short", label: "Short" },
        ].map((d) => (
          <button
            key={d.id}
            onClick={() => setDir(d.id)}
            className={cn("chip", dir === d.id ? "chip-active" : "chip-idle")}
          >
            {d.label}
          </button>
        ))}
      </div>
      {r ? (
        <div className="space-y-1.5 pt-1 border-t border-line/60">
          <ResultRow label="Stop level" value={fmtNum(r.stop)} tone="text-down" />
          <ResultRow label="Stop distance" value={`${fmtNum(r.distPct)}%`} />
          {r.targets.map((t) => (
            <ResultRow key={t.n} label={`Target ${t.n}R`} value={fmtNum(t.level)} tone="text-up" />
          ))}
        </div>
      ) : (
        <p className="text-xs text-dim">Enter valid values.</p>
      )}
    </ToolCard>
  );
}

/* ── 5. Handelszeiten ─────────────────────────────────────────────── */

const SESSIONS = [
  { name: "Sydney", startUtc: 22 * 60, endUtc: 7 * 60 },
  { name: "Tokio", startUtc: 0, endUtc: 9 * 60 },
  { name: "London", startUtc: 8 * 60, endUtc: 16 * 60 + 30 },
  { name: "New York", startUtc: 14 * 60 + 30, endUtc: 21 * 60 },
];

function utcMinutesToLocalLabel(mins) {
  const d = new Date();
  d.setUTCHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function SessionsTool() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const utcDay = now.getUTCDay();
  const isWeekend = utcDay === 0 || utcDay === 6;
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();

  const sessions = SESSIONS.map((s) => {
    const wraps = s.startUtc > s.endUtc;
    const open =
      !isWeekend &&
      (wraps ? utcMins >= s.startUtc || utcMins < s.endUtc : utcMins >= s.startUtc && utcMins < s.endUtc);
    return {
      ...s,
      open,
      range: `${utcMinutesToLocalLabel(s.startUtc)}–${utcMinutesToLocalLabel(s.endUtc)}`,
    };
  });

  const openNames = sessions.filter((s) => s.open).map((s) => s.name);
  const londonNyOverlap = openNames.includes("London") && openNames.includes("New York");

  return (
    <ToolCard icon={Clock} title="Market hours">
      <p className="font-mono text-2xl font-semibold tracking-tight">
        {now.toLocaleTimeString()}
        <span className="text-xs text-dim font-sans font-normal ml-2">
          Local time · {now.toLocaleDateString("en-US", { weekday: "long" })}
        </span>
      </p>
      <div className="space-y-2">
        {sessions.map((s) => (
          <div key={s.name} className="flex items-center justify-between gap-4 text-sm">
            <div className="flex items-center gap-2">
              <span className={cn("w-2 h-2 rounded-full shrink-0", s.open ? "bg-up" : "bg-line")} />
              <span>{s.name}</span>
              <span className="text-xs text-dim font-mono">{s.range}</span>
            </div>
            <span className={cn("text-xs font-medium", s.open ? "text-up" : "text-dim")}>
              {s.open ? "Open" : "Closed"}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full shrink-0 bg-up" />
            <span>Crypto</span>
          </div>
          <span className="text-xs font-medium text-up">Open 24/7</span>
        </div>
      </div>
      {isWeekend && (
        <p className="text-xs text-dim">Weekend — traditional markets closed.</p>
      )}
      {londonNyOverlap && (
        <p className="text-xs text-accent">
          London/New York overlap — highest liquidity.
        </p>
      )}
      {!londonNyOverlap && openNames.length >= 2 && (
        <p className="text-xs text-dim">Overlap {openNames.join("/")}.</p>
      )}
    </ToolCard>
  );
}

/* ── 6. Zinseszins/Compounding ────────────────────────────────────── */

function CompoundingTool() {
  const [start, setStart] = useState("10000");
  const [retPct, setRetPct] = useState("0.5");
  const [tradesPerMonth, setTradesPerMonth] = useState("20");
  const [months, setMonths] = useState("12");

  const r = useMemo(() => {
    const s = num(start), ret = num(retPct), t = num(tradesPerMonth), m = num(months);
    if (!(s > 0) || !Number.isFinite(ret) || !(t > 0) || !(m > 0)) return null;
    const end = s * Math.pow(1 + ret / 100, t * m);
    return { end, totalPct: (end / s - 1) * 100 };
  }, [start, retPct, tradesPerMonth, months]);

  return (
    <ToolCard icon={TrendingUp} title="Compounding">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Starting capital" value={start} onChange={setStart} min="0" />
        <Field label="Return per trade (%)" value={retPct} onChange={setRetPct} />
        <Field label="Trades per month" value={tradesPerMonth} onChange={setTradesPerMonth} min="1" step="1" />
        <Field label="Months" value={months} onChange={setMonths} min="1" step="1" />
      </div>
      {r ? (
        <div className="space-y-1.5 pt-1 border-t border-line/60">
          <ResultRow
            label="Final capital"
            value={fmtNum(r.end)}
            tone={r.end >= num(start) ? "text-up" : "text-down"}
          />
          <ResultRow
            label="Total return"
            value={fmtPct(r.totalPct)}
            tone={r.totalPct >= 0 ? "text-up" : "text-down"}
          />
        </div>
      ) : (
        <p className="text-xs text-dim">Enter valid values.</p>
      )}
      <p className="text-[11px] text-dim leading-relaxed">
        Idealized calculation: constant return per trade, no losing streaks, fees, or taxes.
        Real results will differ.
      </p>
    </ToolCard>
  );
}

/* ── page ─────────────────────────────────────────────────────────── */

export default function Tools() {
  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Tools</p>
      <h1 className="text-2xl font-bold mb-6">Trader tools</h1>

      <div className="grid md:grid-cols-2 gap-4">
        <PositionSizeTool />
        <RiskRewardTool />
        <PivotTool />
        <AtrStopTool />
        <SessionsTool />
        <CompoundingTool />
      </div>

      <p className="text-xs text-dim mt-6">
        All calculations run locally in your browser. Not investment advice.
      </p>
    </div>
  );
}
