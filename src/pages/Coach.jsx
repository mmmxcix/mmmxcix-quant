import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Compass, Lock, KeyRound, Loader2, Check, Circle, ChevronRight,
  ExternalLink, GraduationCap, Flag, AlertTriangle, Cpu, RefreshCw,
} from "lucide-react";
import { fmtPrice } from "@/lib/utils";
import { COACH_PLAN, getCoachDone, setCoachDone, subscribeCoach, courseLessonIds } from "@/lib/coachPlan";
import { getCompleted, subscribeProgress } from "@/lib/academyProgress";
import { cn } from "@/lib/utils";

// Private coach page — the personal roadmap to funded futures trading.
// Gated behind the same dev token as the AI generator: the token is verified
// server-side (constant-time compare in /api/generate with { validate: true }),
// so the page content never shows without a valid token.

const TOKEN_KEY = "quant_dev_token";

function taskIsDone(task, manualDone, academyDone) {
  if (task.course) {
    const ids = courseLessonIds(task.course);
    return ids.length > 0 && ids.every((id) => academyDone.has(id));
  }
  return manualDone.has(task.id);
}

// Live status of the local lab agent (the 24/7 process on the user's PC that
// pushes its state to /api/lab). Private: reads with the dev token.
function LabStatus() {
  const [data, setData] = useState(undefined); // undefined=loading, null=none
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const token = localStorage.getItem("quant_dev_token") || "";
      const res = await fetch("/api/lab", { headers: { "x-lab-token": token } });
      const out = await res.json();
      setData(res.ok ? out.state : null);
    } catch {
      setData(null);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { load(); }, []);

  const age = data?.receivedAt ? Math.round((Date.now() - data.receivedAt) / 60000) : null;
  const online = age !== null && age < 45; // fresh within ~3 schedule ticks

  return (
    <div className="rounded-xl border border-line lg-glass p-4 mb-6">
      <div className="flex items-center gap-2 mb-2">
        <Cpu className="w-4 h-4 text-accent" />
        <p className="text-sm font-semibold">Lab agent (your PC)</p>
        {data !== undefined && (
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            online ? "border-up/40 bg-up/10 text-up" : "border-line bg-bg text-dim"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-up" : "bg-dim/50"}`} />
            {online ? "online" : "offline"}
          </span>
        )}
        <button onClick={load} disabled={busy} className="ml-auto flex items-center gap-1.5 chip chip-idle !text-[11px]">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refresh
        </button>
      </div>
      {data === undefined ? (
        <p className="text-xs text-dim">Checking…</p>
      ) : data === null ? (
        <p className="text-xs text-dim leading-relaxed">
          No state received yet. Set up the local agent (n8n + Node) using the tutorial in the repo
          (<span className="font-mono">docs/LAB_AGENT_TUTORIAL.md</span>) — once it pushes, its status appears here.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-mono">
            <span className="text-dim">last push <span className="text-text">{age === 0 ? "just now" : `${age}m ago`}</span></span>
            <span className="text-dim">mode <span className="text-text">{data.mode || "–"}</span></span>
            <span className="text-dim">strategies <span className="text-text">{data.strategies?.length ?? 0}</span></span>
            {data.prices && Object.entries(data.prices).slice(0, 3).map(([s, p]) => (
              <span key={s} className="text-dim">{s.replace("USDT", "")} <span className="text-text">{fmtPrice(p)}</span></span>
            ))}
            {data.note && <span className="text-dim italic font-sans w-full">“{data.note}”</span>}
          </div>

          {/* Research loop stats (autonomous paper→strategy pipeline) */}
          {data.research && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[10px] text-dim uppercase tracking-widest mb-1.5">Research loop</p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-mono">
                <span className="text-dim">papers read <span className="text-text">{data.research.papersRead}</span></span>
                <span className="text-dim">strategies tried <span className="text-text">{data.research.attempts}</span></span>
                <span className="text-dim">graveyard <span className="text-down">{data.research.graveyard}</span></span>
                <span className="text-dim">candidates <span className="text-up">{data.research.candidates}</span></span>
              </div>
              {data.research.lastGraveyard?.length > 0 && (
                <p className="text-[10px] text-dim/80 mt-1.5 leading-relaxed">
                  latest burials: {data.research.lastGraveyard.map((g) => `"${g.title.slice(0, 40)}…" (${g.reason})`).join(" · ")}
                </p>
              )}
              {data.research.candidates > 0 && (
                <p className="text-[11px] text-up mt-1">
                  → survivors wait in the <Link to="/registry" className="underline">Registry</Link> under “Agent research candidates”.
                </p>
              )}
            </div>
          )}

          {/* Portfolio HQ — paper strategies executed by the agent */}
          {data.mode === "paper" && data.strategies?.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              {data.combined && (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-2 text-sm font-mono">
                  <span className="text-dim text-xs uppercase tracking-widest font-sans">Combined equity</span>
                  <span className="text-text font-semibold">{fmtPrice(data.combined.equity)}</span>
                  <span className={data.combined.returnPct >= 0 ? "text-up" : "text-down"}>
                    {data.combined.returnPct >= 0 ? "+" : ""}{data.combined.returnPct}%
                  </span>
                  <span className="text-[10px] text-dim font-sans">virtual money · paper trading</span>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-left text-dim border-b border-line">
                      <th className="py-1.5 pr-3 font-medium font-sans">Strategy</th>
                      <th className="py-1.5 pr-3 font-medium font-sans">Symbol</th>
                      <th className="py-1.5 pr-3 font-medium font-sans">Position</th>
                      <th className="py-1.5 pr-3 font-medium font-sans text-right">Equity</th>
                      <th className="py-1.5 pr-3 font-medium font-sans text-right">Return</th>
                      <th className="py-1.5 font-medium font-sans text-right">Trades</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.strategies.map((s) => (
                      <tr key={s.id} className="border-b border-line/40 last:border-0">
                        <td className="py-1.5 pr-3 text-text">{s.name}</td>
                        <td className="py-1.5 pr-3 text-dim">{s.symbol} · {s.interval}</td>
                        <td className="py-1.5 pr-3">
                          {s.error
                            ? <span className="text-down" title={s.error}>error</span>
                            : <span className={s.position === "long" ? "text-up" : s.position === "short" ? "text-down" : "text-dim"}>{s.position}</span>}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-text">{s.error ? "–" : fmtPrice(s.equity)}</td>
                        <td className={`py-1.5 pr-3 text-right ${s.returnPct >= 0 ? "text-up" : "text-down"}`}>
                          {s.error ? "–" : `${s.returnPct >= 0 ? "+" : ""}${s.returnPct}%`}
                        </td>
                        <td className="py-1.5 text-right text-dim">{s.error ? "–" : s.tradeCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TaskRow({ task, done, onToggle }) {
  return (
    <div className={cn("flex items-start gap-3 px-4 py-3", done && "opacity-70")}>
      <button
        onClick={() => !task.course && onToggle(task.id, !done)}
        disabled={!!task.course}
        title={task.course ? "Completes automatically when the course is finished" : done ? "Mark as open" : "Mark as done"}
        className={cn("mt-0.5 shrink-0 transition-colors", task.course ? "cursor-default" : "hover:scale-110")}
      >
        {done ? <Check className="w-4 h-4 text-up" /> : <Circle className="w-4 h-4 text-dim/40" />}
      </button>
      <div className="flex-1 min-w-0">
        <p className={cn("text-sm", done ? "text-dim line-through decoration-dim/40" : "text-text")}>
          {task.label}
          {task.optional && <span className="ml-2 text-[10px] text-dim uppercase tracking-wide">optional</span>}
          {task.course && (
            <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-accent/80 uppercase tracking-wide">
              <GraduationCap className="w-3 h-3" /> auto
            </span>
          )}
        </p>
        {task.detail && <p className="text-xs text-dim mt-0.5 leading-relaxed">{task.detail}</p>}
        <div className="flex flex-wrap gap-2 mt-1.5">
          {task.to && (
            <Link to={task.to} className="chip chip-idle !text-[11px] inline-flex items-center gap-1">
              Open <ChevronRight className="w-3 h-3" />
            </Link>
          )}
          {task.lesson && (
            <Link to={task.lesson} className="chip chip-idle !text-[11px] inline-flex items-center gap-1">
              Lesson <ChevronRight className="w-3 h-3" />
            </Link>
          )}
          {task.href && (
            <a href={task.href} target="_blank" rel="noopener noreferrer"
              className="chip chip-idle !text-[11px] inline-flex items-center gap-1">
              {new URL(task.href).hostname.replace("www.", "")} <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Coach() {
  const [token, setToken] = useState(() => {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
  });
  // "checking" | "locked" | "open"
  const [gate, setGate] = useState(token ? "checking" : "locked");
  const [input, setInput] = useState("");
  const [gateError, setGateError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [manualDone, setManualDone] = useState(getCoachDone());
  const [academyDone, setAcademyDone] = useState(getCompleted());

  useEffect(() => subscribeCoach(() => setManualDone(getCoachDone())), []);
  useEffect(() => subscribeProgress(() => setAcademyDone(getCompleted())), []);

  const validate = async (t) => {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ validate: true, token: t }),
    });
    return res.ok;
  };

  // Silently verify a stored token on mount; treat network failure as valid
  // (the page holds a roadmap, not secrets — availability wins offline).
  useEffect(() => {
    if (!token) return;
    let alive = true;
    validate(token)
      .then((ok) => {
        if (!alive) return;
        if (ok) setGate("open");
        else {
          try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
          setToken("");
          setGate("locked");
        }
      })
      .catch(() => alive && setGate("open"));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unlock = async () => {
    const t = input.trim();
    if (!t || busy) return;
    setBusy(true);
    setGateError(null);
    try {
      const ok = await validate(t);
      if (!ok) throw new Error("Invalid token.");
      try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ }
      setToken(t);
      setGate("open");
      window.dispatchEvent(new Event("quant-dev-token"));
    } catch (e) {
      setGateError(e.message === "Invalid token." ? "Invalid token." : "Verification failed — try again.");
    } finally {
      setBusy(false);
    }
  };

  // Progress + "next up" across the whole plan.
  const { phaseStats, nextUp, totalDone, totalTasks } = useMemo(() => {
    let firstOpen = null;
    let doneCount = 0;
    let taskCount = 0;
    const stats = COACH_PLAN.map((phase) => {
      const req = phase.tasks.filter((t) => !t.optional);
      const reqDone = req.filter((t) => taskIsDone(t, manualDone, academyDone)).length;
      const allDone = phase.tasks.filter((t) => taskIsDone(t, manualDone, academyDone)).length;
      taskCount += req.length;
      doneCount += reqDone;
      if (!firstOpen) {
        const openTask = phase.tasks.find((t) => !t.optional && !taskIsDone(t, manualDone, academyDone));
        if (openTask) firstOpen = { phase, task: openTask };
      }
      return { done: allDone, reqDone, reqTotal: req.length, total: phase.tasks.length, complete: reqDone === req.length };
    });
    return { phaseStats: stats, nextUp: firstOpen, totalDone: doneCount, totalTasks: taskCount };
  }, [manualDone, academyDone]);

  // ── Lock screen ─────────────────────────────────────────────────────────
  if (gate !== "open") {
    return (
      <div className="max-w-md mx-auto mt-16">
        <div className="rounded-xl border border-line lg-glass p-6 text-center">
          <Lock className="w-8 h-8 text-dim mx-auto mb-3" />
          <h1 className="text-lg font-bold mb-1">Private area</h1>
          <p className="text-sm text-dim mb-5">This page is personal and requires the dev access token.</p>
          {gate === "checking" ? (
            <p className="flex items-center justify-center gap-2 text-sm text-dim">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking access…
            </p>
          ) : (
            <>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && unlock()}
                  placeholder="Dev access token"
                  className="input-base flex-1 text-sm"
                />
                <button onClick={unlock} disabled={busy || !input.trim()}
                  className="btn-accent flex items-center gap-1.5 text-sm">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />} Unlock
                </button>
              </div>
              {gateError && <p className="text-xs text-down mt-2">{gateError}</p>}
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Coach content ───────────────────────────────────────────────────────
  const pct = totalTasks ? Math.round((totalDone / totalTasks) * 100) : 0;

  return (
    <div className="max-w-4xl">
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Private · only you</p>
      <div className="flex items-center gap-2 mb-2">
        <Compass className="w-6 h-6 text-accent" />
        <h1 className="text-xl sm:text-2xl font-bold">Coach — your path to funded trading</h1>
      </div>
      <p className="text-sm text-dim mb-6 max-w-2xl">
        The full roadmap from here to a funded futures account — phases, tasks, and the go/no-go
        gates between them. Course tasks tick themselves off as you finish Academy lessons;
        everything else you check off manually. Progress is stored in this browser.
      </p>

      <LabStatus />

      {/* Overall progress + next up */}
      <div className="rounded-xl border border-line lg-glass p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-text">Overall progress</span>
          <span className="text-sm font-mono text-accent">{totalDone}/{totalTasks}</span>
        </div>
        <div className="h-2 rounded-full bg-bg overflow-hidden">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        {nextUp ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
            <Flag className="w-4 h-4 text-accent shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[11px] text-dim uppercase tracking-wide">Next up · {nextUp.phase.title}</p>
              <p className="text-sm text-text">{nextUp.task.label}</p>
              <div className="flex flex-wrap gap-2 mt-1.5">
                {(nextUp.task.to || nextUp.task.lesson) && (
                  <Link to={nextUp.task.to || nextUp.task.lesson} className="btn-accent !py-1 !px-3 text-xs inline-flex items-center gap-1">
                    Go <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                )}
                {nextUp.task.href && (
                  <a href={nextUp.task.href} target="_blank" rel="noopener noreferrer"
                    className="chip chip-idle !text-[11px] inline-flex items-center gap-1">
                    {new URL(nextUp.task.href).hostname.replace("www.", "")} <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-up">All phases complete. You know what to do. 🎉</p>
        )}
      </div>

      {/* Phases */}
      <div className="space-y-5">
        {COACH_PLAN.map((phase, pi) => {
          const st = phaseStats[pi];
          const isCurrent = nextUp?.phase.id === phase.id;
          return (
            <div key={phase.id}
              className={cn("rounded-xl border lg-glass overflow-hidden",
                st.complete ? "border-up/30" : isCurrent ? "border-accent/40" : "border-line")}>
              <div className="flex items-center gap-3 p-4 border-b border-line">
                <div className={cn("flex items-center justify-center w-9 h-9 rounded-full border text-sm font-bold shrink-0",
                  st.complete ? "border-up/50 text-up bg-up/10" : isCurrent ? "border-accent/60 text-accent bg-accent/10" : "border-line text-dim")}>
                  {st.complete ? <Check className="w-4 h-4" /> : pi}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-text">
                    {phase.title}
                    {isCurrent && <span className="ml-2 text-[10px] text-accent uppercase tracking-widest">current</span>}
                  </p>
                  <p className="text-xs text-dim">{phase.subtitle}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-mono text-dim">{st.reqDone}/{st.reqTotal}</p>
                  <p className="text-[10px] text-dim/70">{phase.months} · {phase.cost}</p>
                </div>
              </div>

              <div className="divide-y divide-line/40">
                {phase.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    done={taskIsDone(task, manualDone, academyDone)}
                    onToggle={setCoachDone}
                  />
                ))}
              </div>

              {phase.gate && (
                <div className="border-t border-line bg-bg/40 px-4 py-3">
                  <p className="flex items-center gap-1.5 text-[11px] text-yellow-400/90 uppercase tracking-wide mb-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" /> Gate — advance only when ALL of this holds
                  </p>
                  <ul className="list-disc pl-5 space-y-1 text-xs text-dim">
                    {phase.gate.map((g, i) => <li key={i}>{g}</li>)}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-dim/70 mt-6 leading-relaxed">
        Principles behind this plan: pay for evaluations only after the simulator gate is green ·
        size for the drawdown limit, not the profit target · count your strategy variants (overfitting meter) ·
        semi-automated with you at the screen until a firm confirms more in writing.
      </p>
    </div>
  );
}
