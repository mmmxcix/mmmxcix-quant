import { useEffect, useState } from "react";
import { Cpu, Loader2, Check, AlertTriangle } from "lucide-react";
import { cn, fmtNum } from "@/lib/utils";
import { executorStatus, executorOnline, runNative } from "@/lib/nativeJobs";

// "Run natively on my PC" — submit the current strategy to the executor-agent on
// your PC (or VPS), which runs it in its REAL language (C++ / q / native Python /
// JS) through the same fill engine, and shows the result. This is how C++/q
// strategies (which the browser can't run) get backtested, and how heavy runs
// escape the browser tab. Dev-only.

const LANG = { js: "JavaScript", python: "Python", cpp: "C++", q: "kdb+/q" };

export default function NativeRunPanel({ spec }) {
  const [status, setStatus] = useState(undefined); // executor heartbeat
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState(null);
  const [result, setResult] = useState(null);

  const refresh = async () => setStatus(await executorStatus());
  useEffect(() => {
    refresh();
    const id = setInterval(() => { if (!document.hidden) refresh(); }, 30_000);
    return () => clearInterval(id);
  }, []);

  const online = executorOnline(status);
  const tools = status?.executor?.tools || {};
  const lang = (spec?.language || "js").toLowerCase();
  const needsTool = (lang === "cpp" && !tools.cpp) || ((lang === "q" || lang === "kdb+") && !tools.q);

  const run = async () => {
    setRunning(true); setResult(null); setPhase("queued");
    const res = await runNative(spec, setPhase);
    setResult(res); setRunning(false); setPhase(null);
    refresh();
  };

  return (
    <div className="rounded-xl border border-line lg-glass p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Cpu className="w-4 h-4 text-accent" />
        <p className="text-sm font-semibold">Run natively on my PC</p>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
          online ? "border-up/40 bg-up/10 text-up" : "border-line bg-bg text-dim")}>
          <span className={cn("w-1.5 h-1.5 rounded-full", online ? "bg-up" : "bg-dim/50")} />
          {online ? "executor online" : "executor offline"}
        </span>
        {online && status?.executor?.host && (
          <span className="text-[10px] text-dim font-mono">{status.executor.host} · {["cpp","q","python","node"].filter((t) => tools[t]).join(" · ") || "no tools"}</span>
        )}
        <button
          onClick={run}
          disabled={running || !online || needsTool || !spec?.code}
          className="chip chip-idle !text-xs flex items-center gap-1.5 hover:text-accent ml-auto disabled:opacity-50">
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cpu className="w-3.5 h-3.5" />}
          {running ? (phase || "running") + "…" : `Run ${LANG[lang] || lang}`}
        </button>
      </div>

      {!online && (
        <p className="text-[10px] text-dim">
          Start the executor on your PC (the agent-daemon runs it automatically; or <span className="font-mono">node scripts/executor-agent.mjs</span> with LAB_TOKEN + LAB_SITE set). It reports which toolchains it has.
        </p>
      )}
      {online && needsTool && (
        <p className="text-[10px] text-warn flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> This is {LANG[lang]}, but the executor doesn't have {lang === "cpp" ? "g++" : "a q binary"} installed — install it on the runner to enable {LANG[lang]}.
        </p>
      )}

      {result && (
        result.ok ? (
          <div className="rounded-lg border border-up/40 bg-up/5 p-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono">
            <span className="text-up font-semibold flex items-center gap-1"><Check className="w-3.5 h-3.5" /> ran in {LANG[result.language] || result.language}</span>
            <span className={result.metrics.totalReturnPct >= 0 ? "text-up" : "text-down"}>ret {fmtNum(result.metrics.totalReturnPct, 1)}%</span>
            <span className="text-dim">Sharpe {fmtNum(result.metrics.sharpe, 2)}</span>
            <span className="text-down">maxDD {fmtNum(result.metrics.maxDrawdownPct, 1)}%</span>
            <span className="text-dim">PF {fmtNum(result.metrics.profitFactor, 2)}</span>
            <span className="text-dim">{result.metrics.tradeCount} trades</span>
            <span className="text-dim/70">{result.symbol} {result.interval} · {result.candleCount} bars · {result.host}</span>
          </div>
        ) : (
          <p className="text-[11px] text-down flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" /> {result.error || (result.toolMissing ? `install ${result.toolMissing} on the runner` : "run failed")}
          </p>
        )
      )}
    </div>
  );
}
