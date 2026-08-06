import { GLOSSARY } from "@/lib/glossary";
import { cn } from "@/lib/utils";

// Inline metric term with a hover definition pulled from the shared glossary.
// A faint dotted underline + help cursor signal "there's an explanation here"
// without shouting; the native title tooltip carries the plain-language line.
//
//   <Abbr t="PF" />            → renders "PF", tooltip = Profit Factor …
//   <Abbr t="Max drawdown">Max drawdown</Abbr>   → custom visible label
//
// Falls back to plain text (no underline) when the term isn't in the glossary,
// so a typo degrades gracefully instead of dangling an empty tooltip.
export default function Abbr({ t, children, className }) {
  const def = GLOSSARY[t];
  if (!def) return <span className={className}>{children ?? t}</span>;
  return (
    <span
      title={def}
      className={cn(
        "cursor-help underline decoration-dotted decoration-dim/50 underline-offset-2",
        className,
      )}
    >
      {children ?? t}
    </span>
  );
}
