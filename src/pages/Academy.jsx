import { useEffect, useMemo, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { GraduationCap, Clock, ChevronRight, ArrowLeft, Lightbulb, Check, Circle, Compass } from "lucide-react";
import { ACADEMY } from "@/lib/academyContent";
import { getCompleted, setDone, subscribeProgress } from "@/lib/academyProgress";
import { cn } from "@/lib/utils";

// Renders one content block. Only the fixed block types from academyContent.js
// are handled — plain text, no HTML (no XSS surface).
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
    default:
      return <p className="text-dim leading-relaxed">{block.text}</p>;
  }
}

const ALL_LESSONS = ACADEMY.flatMap((cat, ci) =>
  cat.lessons.map((l) => ({ ...l, categoryId: cat.id, categoryTitle: cat.title, level: ci + 1 }))
);

export default function Academy() {
  const [params, setParams] = useSearchParams();
  const lessonId = params.get("l");
  const [done, setDoneState] = useState(getCompleted());

  useEffect(() => subscribeProgress(() => setDoneState(getCompleted())), []);

  const lesson = useMemo(() => ALL_LESSONS.find((l) => l.id === lessonId), [lessonId]);
  const lessonIndex = useMemo(() => ALL_LESSONS.findIndex((l) => l.id === lessonId), [lessonId]);

  const openLesson = (id) => { setParams({ l: id }); window.scrollTo(0, 0); };
  const closeLesson = () => setParams({});

  const totalDone = ALL_LESSONS.filter((l) => done.has(l.id)).length;
  const total = ALL_LESSONS.length;
  const pct = total ? Math.round((totalDone / total) * 100) : 0;

  // ── Reader view ────────────────────────────────────────────────────────
  if (lesson) {
    const prev = lessonIndex > 0 ? ALL_LESSONS[lessonIndex - 1] : null;
    const next = lessonIndex < ALL_LESSONS.length - 1 ? ALL_LESSONS[lessonIndex + 1] : null;
    const isDone = done.has(lesson.id);
    return (
      <div className="max-w-3xl">
        <button onClick={closeLesson} className="flex items-center gap-1.5 text-sm text-dim hover:text-text transition-colors mb-4">
          <ArrowLeft className="w-4 h-4" /> Zurück zum Lernpfad
        </button>
        <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Level {lesson.level} · {lesson.categoryTitle}</p>
        <h1 className="text-2xl font-bold mb-2">{lesson.title}</h1>
        <p className="flex items-center gap-1.5 text-xs text-dim mb-6"><Clock className="w-3.5 h-3.5" /> {lesson.minutes} Min. Lesezeit</p>

        <article className="space-y-4 text-sm">
          {lesson.body.map((b, i) => <Block key={i} block={b} />)}
        </article>

        <button onClick={() => setDone(lesson.id, !isDone)}
          className={cn("mt-8 flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
            isDone ? "bg-up/15 border border-up/40 text-up" : "btn-accent")}>
          <Check className="w-4 h-4" /> {isDone ? "Als erledigt markiert" : "Als erledigt markieren"}
        </button>

        <div className="flex justify-between gap-3 mt-8 pt-6 border-t border-line">
          {prev ? (
            <button onClick={() => openLesson(prev.id)} className="btn-ghost text-left max-w-[48%]">
              <span className="block text-[10px] text-dim uppercase tracking-wide">Zurück</span>
              <span className="text-sm truncate block">{prev.title}</span>
            </button>
          ) : <span />}
          {next && (
            <button onClick={() => openLesson(next.id)} className="btn-ghost text-right max-w-[48%] ml-auto">
              <span className="block text-[10px] text-dim uppercase tracking-wide">Weiter</span>
              <span className="text-sm truncate block">{next.title}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Learning-path overview ─────────────────────────────────────────────
  // Find the first not-yet-done lesson to highlight as "continue here".
  const nextUp = ALL_LESSONS.find((l) => !done.has(l.id));

  return (
    <div className="max-w-4xl">
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Lernpfad</p>
      <div className="flex items-center gap-2 mb-2">
        <GraduationCap className="w-6 h-6 text-accent" />
        <h1 className="text-xl sm:text-2xl font-bold">Quant Academy</h1>
      </div>
      <p className="text-sm text-dim mb-5 max-w-2xl">
        Ein Weg vom kompletten Einsteiger bis zu dem Punkt, an dem du eigenständig weiterkommst.
        Arbeite die Level der Reihe nach durch — jede Lektion ist mit den Werkzeugen dieser Seite verknüpft.
      </p>

      {/* Overall progress */}
      <div className="rounded-xl border border-line lg-glass p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-text">Dein Fortschritt</span>
          <span className="text-sm font-mono text-accent">{totalDone}/{total}</span>
        </div>
        <div className="h-2 rounded-full bg-bg overflow-hidden">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        {nextUp && (
          <button onClick={() => openLesson(nextUp.id)} className="btn-accent mt-3 text-sm">
            {totalDone === 0 ? "Jetzt starten" : "Weiterlernen"}: {nextUp.title}
          </button>
        )}
        {!nextUp && total > 0 && (
          <p className="mt-3 text-sm text-up">Alles abgeschlossen — du bist bereit, eigenständig weiterzugehen. 🎉</p>
        )}
      </div>

      {/* Levels */}
      <div className="space-y-4">
        {ACADEMY.map((cat, ci) => {
          const lessonsDone = cat.lessons.filter((l) => done.has(l.id)).length;
          const complete = lessonsDone === cat.lessons.length;
          return (
            <div key={cat.id} className="rounded-xl border border-line lg-glass overflow-hidden">
              <div className="flex items-center gap-3 p-4 border-b border-line">
                <div className={cn("flex items-center justify-center w-9 h-9 rounded-full border text-sm font-bold shrink-0",
                  complete ? "border-up/50 text-up bg-up/10" : "border-accent/40 text-accent")}>
                  {complete ? <Check className="w-4 h-4" /> : ci + 1}
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-text">Level {ci + 1}: {cat.title}</p>
                  <p className="text-xs text-dim">{cat.description}</p>
                </div>
                <span className="text-xs font-mono text-dim shrink-0">{lessonsDone}/{cat.lessons.length}</span>
              </div>
              <div className="divide-y divide-line/50">
                {cat.lessons.map((l) => {
                  const d = done.has(l.id);
                  return (
                    <button key={l.id} onClick={() => openLesson(l.id)}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg/60 transition-colors">
                      {d ? <Check className="w-4 h-4 text-up shrink-0" /> : <Circle className="w-4 h-4 text-dim/40 shrink-0" />}
                      <span className={cn("flex-1 text-sm", d ? "text-dim" : "text-text")}>{l.title}</span>
                      <span className="flex items-center gap-1 text-[11px] text-dim shrink-0"><Clock className="w-3 h-3" /> {l.minutes}m</span>
                      <ChevronRight className="w-4 h-4 text-dim/50 shrink-0" />
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Continue-on-your-own */}
      <div className="rounded-xl border border-line lg-glass p-5 mt-6">
        <div className="flex items-center gap-2 mb-2">
          <Compass className="w-5 h-5 text-accent" />
          <p className="font-semibold text-text">Ab hier kommst du allein weiter</p>
        </div>
        <p className="text-sm text-dim mb-3">
          Wenn du die Level durch hast, kennst du die Grundlagen, Indikatoren, Backtesting und Risikomanagement.
          Der nächste Schritt ist eigenes Ausprobieren: baue Strategien im Backtest, scanne den Markt im Screener,
          und vertiefe dich mit den kuratierten externen Quellen.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to="/backtest" className="chip chip-idle">Zum Backtest</Link>
          <Link to="/screener" className="chip chip-idle">Zum Screener</Link>
          <Link to="/resources" className="chip chip-idle">Externe Ressourcen</Link>
        </div>
      </div>
    </div>
  );
}
