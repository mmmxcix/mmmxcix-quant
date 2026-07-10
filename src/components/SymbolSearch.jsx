import { useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { searchSymbols, localMatches, warmup } from "@/lib/search";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 150;
const MIN_CHARS = 1;

// Autocomplete input: type a ticker or name, pick from the dropdown, and
// onSelect(symbol) fires with the plain ticker string. Debounce lives here;
// searchSymbols itself is debounce-free.
export default function SymbolSearch({
  market,
  value,
  onSelect,
  placeholder = "Search symbol or name…",
  className,
}) {
  const [input, setInput] = useState(value || "");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);

  const debounceRef = useRef(null);
  const requestRef = useRef(0);
  const blurRef = useRef(null);
  const listRef = useRef(null);

  // Sync from parent (e.g. market switch or URL-driven symbol change).
  useEffect(() => {
    setInput(value || "");
    setResults([]);
    setOpen(false);
    setActive(-1);
  }, [value, market]);

  // Pre-load the Binance symbol list so the first crypto keystroke is instant.
  useEffect(() => {
    warmup(market);
  }, [market]);

  // Cleanup pending timers on unmount.
  useEffect(
    () => () => {
      clearTimeout(debounceRef.current);
      clearTimeout(blurRef.current);
    },
    []
  );

  const runSearch = (query) => {
    const id = ++requestRef.current;
    setLoading(true);
    searchSymbols(query, market)
      .then((list) => {
        if (id !== requestRef.current) return; // stale response
        setResults(list);
        setOpen(list.length > 0);
        setActive(list.length > 0 ? 0 : -1);
      })
      .finally(() => {
        if (id === requestRef.current) setLoading(false);
      });
  };

  const handleChange = (e) => {
    const q = e.target.value;
    setInput(q);
    clearTimeout(debounceRef.current);
    if (q.trim().length < MIN_CHARS) {
      requestRef.current++; // invalidate in-flight search
      setResults([]);
      setOpen(false);
      setActive(-1);
      setLoading(false);
      return;
    }
    // Instant tier: synchronous local hits (name maps, cached lists) appear
    // on the very same keystroke; the full search replaces them shortly after.
    const instant = localMatches(q.trim(), market);
    if (instant.length > 0) {
      setResults(instant);
      setOpen(true);
      setActive(0);
    }
    debounceRef.current = setTimeout(() => runSearch(q.trim()), DEBOUNCE_MS);
  };

  const select = (symbol) => {
    clearTimeout(debounceRef.current);
    requestRef.current++;
    setInput(symbol);
    setOpen(false);
    setActive(-1);
    setLoading(false);
    onSelect?.(symbol);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && active >= 0 && results[active]) {
        select(results[active].symbol);
      } else {
        const raw = input.trim().toUpperCase();
        if (raw) select(raw);
      }
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    }
  };

  // Keep the active row visible while arrowing through a long list.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current
      ?.children[active]
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const handleBlur = () => {
    // Delay so a click on a dropdown row lands before we close it.
    blurRef.current = setTimeout(() => setOpen(false), 150);
  };

  const handleFocus = () => {
    clearTimeout(blurRef.current);
    if (results.length > 0 && input.trim().length >= MIN_CHARS) setOpen(true);
  };

  return (
    <div className={cn("relative", className)}>
      <input
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onFocus={handleFocus}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className="input-base font-mono w-full pr-9"
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-dim">
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Search className="w-4 h-4" />
        )}
      </span>

      {open && results.length > 0 && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1 z-50 max-h-72 overflow-auto rounded-lg border border-line bg-surface/75 backdrop-blur-xl shadow-lg shadow-black/40"
        >
          {results.map((r, i) => (
            <li
              key={`${r.symbol}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()} // keep input focus
              onClick={() => select(r.symbol)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex items-center gap-3 px-3 py-2 text-sm cursor-pointer",
                i === active ? "bg-accent/10" : "hover:bg-accent/10"
              )}
            >
              <span className="font-mono font-semibold shrink-0">{r.symbol}</span>
              <span className="text-dim truncate flex-1">{r.name}</span>
              <span className="text-[10px] uppercase tracking-wide text-dim shrink-0">
                {[r.exchange, r.type].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
