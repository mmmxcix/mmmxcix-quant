import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Compass, Lock, KeyRound, Loader2, Check, Circle, ChevronRight,
  ExternalLink, GraduationCap, Flag, AlertTriangle, Cpu, RefreshCw,
} from "lucide-react";
import { fmtPrice } from "@/lib/utils";
import { COACH_PLAN, getCoachDone, setCoachDone, subscribeCoach, courseLessonIds } from "@/lib/coachPlan";
import { getCompleted, subscribeProgress } from "@/lib/academyProgress";
import { strategyToCode } from "@/lib/strategyCode";
import CopyButton from "@/components/CopyButton";
import Skeleton from "@/components/Skeleton";
import { useSession } from "@/lib/authClient";
import { cn } from "@/lib/utils";

// Private coach page — the personal roadmap to funded futures trading.
// Gated on the signed-in ADMIN (dev) account: the session cookie is verified
// server-side on every /api/lab read, and the page shows a lock screen for
// everyone else.

function taskIsDone(task, manualDone, academyDone) {
  if (task.course) {
    const ids = courseLessonIds(task.course);
    return ids.length > 0 && ids.every((id) => academyDone.has(id));
  }
  return manualDone.has(task.id);
}

// Today's P&L for the paper book, derived client-side from the combined equity
// history so it tracks the VIEWER's local day and stays live. Baseline = the
// equity carried into today (the last snapshot strictly before local midnight);
// if history doesn't reach back that far, the earliest snapshot today is used.
// combined.history = [{ t: ms, v: equity }], ascending.
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
  // Gate = the Better Auth ADMIN session (the dev account). No more token
  // unlock: sign in at /login and the page simply opens.
  const { data: session, isPending } = useSession();
  const authed = session?.user?.role === "admin";

  const [manualDone, setManualDone] = useState(getCoachDone());
  const [academyDone, setAcademyDone] = useState(getCompleted());

  useEffect(() => subscribeCoach(() => setManualDone(getCoachDone())), []);
  useEffect(() => subscribeProgress(() => setAcademyDone(getCompleted())), []);

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
  if (!authed) {
    return (
      <div className="max-w-md mx-auto mt-16">
        <div className="rounded-xl border border-line lg-glass p-6 text-center">
          <Lock className="w-8 h-8 text-dim mx-auto mb-3" />
          <h1 className="text-lg font-bold mb-1">Private area</h1>
          {isPending ? (
            <p className="flex items-center justify-center gap-2 text-sm text-dim">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking access…
            </p>
          ) : session ? (
            <p className="text-sm text-dim">This page is limited to the dev account.</p>
          ) : (
            <p className="text-sm text-dim">
              This page is personal.{" "}
              <Link to="/login?next=/coach" className="text-accent hover:underline">Sign in</Link>{" "}
              with the dev account to continue.
            </p>
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
                    {isCurrent && <span className="ml-2 text-[10px] text-accent font-medium">current</span>}
                  </p>
                  <p className="text-xs text-dim">{phase.subtitle}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-mono text-dim">{st.reqDone}/{st.reqTotal}</p>
                  <p className="text-[10px] text-dim">{phase.months} · {phase.cost}</p>
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
                  <p className="flex items-center gap-1.5 text-[11px] text-warn/90 uppercase tracking-wide mb-1.5">
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

      <p className="text-[11px] text-dim mt-6 leading-relaxed">
        Principles behind this plan: pay for evaluations only after the simulator gate is green ·
        size for the drawdown limit, not the profit target · count your strategy variants (overfitting meter) ·
        semi-automated with you at the screen until a firm confirms more in writing.
      </p>
    </div>
  );
}
