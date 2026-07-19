import { useState, useRef, useEffect } from "react";
import { Copy, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

// CopyButton — put generated strategy code on the clipboard.
//
// navigator.clipboard is unavailable on insecure origins and can be blocked by
// permissions policy, so the failure is surfaced rather than swallowed: a
// button that silently does nothing is worse than one that says it couldn't.
// The textarea fallback covers the non-secure-context case (e.g. plain-http
// LAN preview) where the async API simply is not there.
export default function CopyButton({ text, label = "Copy code", className, size = "sm" }) {
  const [state, setState] = useState("idle"); // idle | ok | fail
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = (s) => {
    setState(s);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };

  const copy = async () => {
    const value = String(text ?? "");
    if (!value) return flash("fail");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return flash("ok");
      }
      // Fallback for insecure origins: a hidden textarea + execCommand.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      flash(ok ? "ok" : "fail");
    } catch {
      flash("fail");
    }
  };

  const Icon = state === "ok" ? Check : state === "fail" ? X : Copy;
  const text_ = state === "ok" ? "Copied" : state === "fail" ? "Copy failed" : label;

  return (
    <button
      type="button"
      onClick={copy}
      title={state === "fail" ? "Clipboard unavailable — select the code and copy manually" : label}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border transition-colors",
        size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm",
        state === "ok" ? "border-up/40 text-up bg-up/5"
          : state === "fail" ? "border-down/40 text-down bg-down/5"
          : "border-line text-dim hover:text-text hover:border-dim",
        className
      )}
    >
      <Icon className={size === "sm" ? "w-3.5 h-3.5" : "w-4 h-4"} />
      {text_}
    </button>
  );
}
