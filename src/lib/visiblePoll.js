// visiblePoll.js — setInterval that does nothing while the tab is hidden.
//
// Every poll on this site that hits /api/* is a Pages Function invocation
// (100k/day on the free plan), and a background tab nobody is looking at was
// spending them at full rate. While `document.hidden`, ticks are skipped;
// when the tab comes back and a tick is overdue, it runs once immediately so
// the page isn't showing data older than its own interval.
//
// Does NOT run `fn` at start — callers keep their own initial load, exactly
// as with setInterval. Returns a cleanup function.

export function visibleInterval(fn, ms) {
  const doc = typeof document !== "undefined" ? document : null;
  let last = Date.now();
  const run = () => { last = Date.now(); fn(); };
  const id = setInterval(() => { if (!doc?.hidden) run(); }, ms);
  const onVisible = () => { if (!doc.hidden && Date.now() - last >= ms) run(); };
  doc?.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(id);
    doc?.removeEventListener("visibilitychange", onVisible);
  };
}
