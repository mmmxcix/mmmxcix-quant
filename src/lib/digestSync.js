// Keeps an active newsletter subscription's symbol list in sync with the
// user's LIVE portfolio/watchlist, so "Your portfolio" in the digest never
// goes stale the way it did before this existed (subscribe.js only ever
// captured a one-time snapshot at signup/prefs-save time).
//
// Deliberately conservative: it only ever UPDATES an existing subscription's
// prefs, never creates a new one. If /api/subscribe's response indicates a
// brand-new record was created (the `mailed` field only appears on that
// path — see functions/api/subscribe.js), that means the subscription was
// deleted (unsubscribed) since we last synced it; re-subscribing someone who
// explicitly opted out is not this feature's call to make, so it stops
// tracking instead.

import { distinctSymbols, subscribe as onPortfolioChange } from "@/lib/portfolio";

const TARGET_KEY = "quant_digest_sync";
const DEBOUNCE_MS = 5000;

function loadTarget() {
  try {
    const raw = localStorage.getItem(TARGET_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.email === "string" ? parsed : null;
  } catch {
    return null;
  }
}

// Called by NewsletterCard right after a successful subscribe/update whose
// categories include portfolio/watchlist — this is what "activates" tracking
// for this browser. `prefs` is { categories, freeOnly, sources } (no symbols;
// those are always read fresh from distinctSymbols() at resync time).
export function saveDigestSyncTarget({ email, prefs, symbols }) {
  try {
    localStorage.setItem(
      TARGET_KEY,
      JSON.stringify({ email, prefs, lastSymbolsJSON: JSON.stringify(symbols) })
    );
  } catch {
    /* private mode — tracking just won't persist across reloads */
  }
}

// Called when the saved categories no longer include portfolio/watchlist (or
// self-healing after a detected unsubscribe) — stop auto-reposting.
export function clearDigestSyncTarget() {
  try {
    localStorage.removeItem(TARGET_KEY);
  } catch {
    /* ignore */
  }
}

async function resyncNow(target) {
  const symbols = distinctSymbols();
  const symbolsJSON = JSON.stringify(symbols);
  if (symbolsJSON === target.lastSymbolsJSON) return; // nothing actually changed

  try {
    const res = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: target.email, prefs: { ...target.prefs, symbols } }),
    });
    if (!res.ok) return; // transient failure — the next mutation/app-load retries
    const data = await res.json().catch(() => ({}));
    if ("mailed" in data) { clearDigestSyncTarget(); return; } // was unsubscribed — see file header
    saveDigestSyncTarget({ email: target.email, prefs: target.prefs, symbols });
  } catch {
    /* offline — retried on next mutation/load */
  }
}

// Call once from the app shell (Layout.jsx). Does an immediate catch-up
// check, then re-checks (debounced) on every future portfolio/watchlist
// mutation for as long as the tab stays open. Returns a cleanup function.
export function initDigestAutoResync() {
  let timer = null;
  const check = () => {
    const target = loadTarget();
    if (target) resyncNow(target);
  };

  check();
  const unsubscribe = onPortfolioChange(() => {
    clearTimeout(timer);
    timer = setTimeout(check, DEBOUNCE_MS);
  });

  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
