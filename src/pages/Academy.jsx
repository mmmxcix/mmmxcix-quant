import { useEffect, useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { GraduationCap, Clock, ChevronRight, ArrowLeft, Lightbulb, Check, Circle, Compass, BookOpen, Zap, Sigma, Trophy, Telescope } from "lucide-react";
import { COURSES } from "@/lib/academyContent";
import { getCompleted, setDone, subscribeProgress } from "@/lib/academyProgress";
import AcademyDiagram from "@/components/AcademyDiagram";
import { cn } from "@/lib/utils";

const COURSE_ICON = { "quant-foundations": BookOpen, "day-trading": Zap, "futures-prop": Trophy, "options-derivatives": Sigma, "anomalies-factors": Telescope };

// Renders one content block. Only fixed block types — plain text, no HTML.
function Block({ block }) {
  switch (block.type) {
    case "h":
      return <h3 className="text-base font-semibold text-text pt-3">{block.text}</h3>;
    case "ul":
      return <ul className="list-disc pl-5 space-y-1 text-dim">{block.items.map((it, i) => <li key={i}>{it}</li>)}</ul>;
    case "tip":
      return (
        <div className="flex gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <Lightbulb className="w-4 h-4 text-accent shrink-0 mt-0.5" />
          <p className="text-sm text-text/90">{block.text}</p>
        </div>
      );
    case "formula":
      return <pre className="rounded-lg border border-line bg-bg px-3 py-2 text-sm font-mono text-accent overflow-x-auto">{block.text}</pre>;
    case "diagram":
      return <AcademyDiagram id={block.id} caption={block.caption} />;
    default:
      return <p className="text-dim leading-relaxed">{block.text}</p>;
  }
}

// Flatten a single course's lessons for reader nav (prev/next within course).
function courseLessons(course) {
  return course.levels.flatMap((lvl, li) =>
    lvl.lessons.map((l) => ({ ...l, levelId: lvl.id, levelTitle: lvl.title, level: li + 1 }))
  );
}

export default function Academy() {
  const [params, setParams] = useSearchParams();
  const courseId = params.get("c");
  const lessonId = params.get("l");
  const [done, setDoneState] = useState(getCompleted());

  useEffect(() => subscribeProgress(() => setDoneState(getCompleted())), []);

  const course = useMemo(() => COURSES.find((c) => c.id === courseId) || null, [courseId]);
  const lessons = useMemo(() => (course ? courseLessons(course) : []), [course]);
  const lesson = useMemo(() => lessons.find((l) => l.id === lessonId), [lessons, lessonId]);
  const lessonIndex = useMemo(() => lessons.findIndex((l) => l.id === lessonId), [lessons, lessonId]);

  const openCourse = (id) => { setParams({ c: id }); window.scrollTo(0, 0); };
  const openLesson = (id) => { setParams({ c: courseId, l: id }); window.scrollTo(0, 0); };
  const backToCourse = () => setParams({ c: courseId });
  const backToHub = () => setParams({});

  // ── Lesson reader ──────────────────────────────────────────────────────
  if (course && lesson) {
    const prev = lessonIndex > 0 ? lessons[lessonIndex - 1] : null;
    const next = lessonIndex < lessons.length - 1 ? lessons[lessonIndex + 1] : null;
    const isDone = done.has(lesson.id);
    return (
      <div className="max-w-3xl">
        <button onClick={backToCourse} className="flex items-center gap-1.5 text-sm text-dim hover:text-text transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to {course.title}
        </button>
        <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Level {lesson.level} · {lesson.levelTitle}</p>
        <h1 className="text-2xl font-bold mb-2">{lesson.title}</h1>
        <p className="flex items-center gap-1.5 text-xs text-dim mb-6"><Clock className="w-3.5 h-3.5" /> {lesson.minutes} min read</p>

        <article className="space-y-4 text-sm">{lesson.body.map((b, i) => <Block key={i} block={b} />)}</article>

        <button onClick={() => setDone(lesson.id, !isDone)}
          className={cn("mt-8 flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
            isDone ? "bg-up/15 border border-up/40 text-up" : "btn-accent")}>
          <Check className="w-4 h-4" /> {isDone ? "Marked as done" : "Mark as done"}
        </button>

        <div className="flex justify-between gap-3 mt-8 pt-6 border-t border-line">
          {prev ? (
            <button onClick={() => openLesson(prev.id)} className="btn-ghost text-left max-w-[48%]">
              <span className="block text-[10px] text-dim uppercase tracking-wide">Previous</span>
              <span className="text-sm truncate block">{prev.title}</span>
            </button>
          ) : <span />}
          {next && (
            <button onClick={() => openLesson(next.id)} className="btn-ghost text-right max-w-[48%] ml-auto">
              <span className="block text-[10px] text-dim uppercase tracking-wide">Next</span>
              <span className="text-sm truncate block">{next.title}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Course path (levels + lessons) ─────────────────────────────────────
  if (course) {
    const totalDone = lessons.filter((l) => done.has(l.id)).length;
    const pct = lessons.length ? Math.round((totalDone / lessons.length) * 100) : 0;
    const nextUp = lessons.find((l) => !done.has(l.id));
    return (
      <div className="max-w-4xl">
        <button onClick={backToHub} className="flex items-center gap-1.5 text-sm text-dim hover:text-text transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" /> All courses
        </button>
        <h1 className="text-xl sm:text-2xl font-bold mb-1">{course.title}</h1>
        <p className="text-sm text-dim mb-5 max-w-2xl">{course.description}</p>

        <div className="rounded-xl border border-line lg-glass p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-text">Your progress</span>
            <span className="text-sm font-mono text-accent">{totalDone}/{lessons.length}</span>
          </div>
          <div className="h-2 rounded-full bg-bg overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          {nextUp && (
            <button onClick={() => openLesson(nextUp.id)} className="btn-accent mt-3 text-sm">
              {totalDone === 0 ? "Start" : "Continue"}: {nextUp.title}
            </button>
          )}
          {!nextUp && lessons.length > 0 && (
            <p className="mt-3 text-sm text-up">Course complete — nicely done. 🎉</p>
          )}
        </div>

        <div className="space-y-4">
          {course.levels.map((lvl, li) => {
            const lessonsDone = lvl.lessons.filter((l) => done.has(l.id)).length;
            const complete = lessonsDone === lvl.lessons.length;
            return (
              <div key={lvl.id} className="rounded-xl border border-line lg-glass overflow-hidden">
                <div className="flex items-center gap-3 p-4 border-b border-line">
                  <div className={cn("flex items-center justify-center w-9 h-9 rounded-full border text-sm font-bold shrink-0",
                    complete ? "border-up/50 text-up bg-up/10" : "border-accent/40 text-accent")}>
                    {complete ? <Check className="w-4 h-4" /> : li + 1}
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-text">Level {li + 1}: {lvl.title}</p>
                    <p className="text-xs text-dim">{lvl.description}</p>
                  </div>
                  <span className="text-xs font-mono text-dim shrink-0">{lessonsDone}/{lvl.lessons.length}</span>
                </div>
                <div className="divide-y divide-line/50">
                  {lvl.lessons.map((l) => {
                    const d = done.has(l.id);
                    return (
                      <button key={l.id} onClick={() => openLesson(l.id)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg/60 transition-colors">
                        {d ? <Check className="w-4 h-4 text-up shrink-0" /> : <Circle className="w-4 h-4 text-dim/55 shrink-0" />}
                        <span className={cn("flex-1 text-sm", d ? "text-dim" : "text-text")}>{l.title}</span>
                        <span className="flex items-center gap-1 text-[11px] text-dim shrink-0"><Clock className="w-3 h-3" /> {l.minutes}m</span>
                        <ChevronRight className="w-4 h-4 text-dim shrink-0" />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="rounded-xl border border-line lg-glass p-5 mt-6">
          <div className="flex items-center gap-2 mb-2">
            <Compass className="w-5 h-5 text-accent" />
            <p className="font-semibold text-text">Put it into practice</p>
          </div>
          <p className="text-sm text-dim mb-3">
            Theory sticks when you apply it. Build strategies in the Backtest, scan the market in the Screener,
            explore live option chains, or dig deeper with the curated external sources.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link to="/backtest" className="chip chip-idle">Backtest</Link>
            <Link to="/screener" className="chip chip-idle">Screener</Link>
            <Link to="/options" className="chip chip-idle">Options</Link>
            <Link to="/anomalies" className="chip chip-idle">Anomalies</Link>
            <Link to="/resources" className="chip chip-idle">Resources</Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Course hub ─────────────────────────────────────────────────────────
  return (
    <div className="max-w-4xl">
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Learn</p>
      <div className="flex items-center gap-2 mb-2">
        <GraduationCap className="w-6 h-6 text-accent" />
        <h1 className="text-xl sm:text-2xl font-bold">Academy</h1>
      </div>
      <p className="text-sm text-dim mb-6 max-w-2xl">
        Structured courses from complete beginner to the point where you continue on your own.
        Pick a track and work through the levels in order. Not investment advice.{" "}
        New here? The <Link to="/guide" className="text-accent hover:underline">Guide</Link> explains
        every tool on this platform and how the courses connect to them.
      </p>

      <div className="grid sm:grid-cols-2 gap-4">
        {COURSES.map((c) => {
          const all = courseLessons(c);
          const cDone = all.filter((l) => done.has(l.id)).length;
          const pct = all.length ? Math.round((cDone / all.length) * 100) : 0;
          const Icon = COURSE_ICON[c.id] || BookOpen;
          return (
            <button key={c.id} onClick={() => openCourse(c.id)}
              className="group text-left rounded-xl border border-line lg-glass p-5 hover:border-accent/40 transition-colors">
              <div className="flex items-center justify-between mb-3">
                <Icon className="w-6 h-6 text-accent" />
                <ChevronRight className="w-4 h-4 text-dim group-hover:text-accent transition-colors" />
              </div>
              <p className="font-semibold text-text mb-1">{c.title}</p>
              <p className="text-sm text-dim mb-4">{c.description}</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-bg overflow-hidden">
                  <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-[11px] font-mono text-dim shrink-0">{cDone}/{all.length}</span>
              </div>
              <p className="text-[11px] text-dim mt-2">{c.levels.length} levels · {all.length} lessons</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
