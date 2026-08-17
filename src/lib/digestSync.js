// Keeps an active newsletter subscription's symbol list in sync with the
// user's LIVE portfolio/watchlist, so "Your portfolio" in the digest never
// goes stale the way it did before this existed (subscribe.js only ever
// captured a one-time snapshot at signup/prefs-save time).
//
// Also owns the digest's SYMBOL LIST itself, which can diverge from the raw
// watchlist/portfolio once the user customizes it on the Briefing tab (the
// digest builder) — see getDigestSymbols(). Once customized, auto-resync
// must respect that override rather than silently clobbering it back to the
// live portfolio on the next trade.
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
const CUSTOM_SYMBOLS_KEY = "quant_digest_symbols";
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

// Whether this browser has an active tracked subscription — the Briefing
// builder uses this to decide whether "Save to my digest email" applies.
export function hasDigestSubscription() {
  return !!loadTarget();
}

// Called by NewsletterCard right after a successful subscribe/update whose
// categories include portfolio/watchlist — this is what "activates" tracking
// for this browser. `prefs` is { categories, freeOnly, sources } (no symbols;
// those are always read fresh at resync time).
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

// ── Digest symbol list (the builder on the Briefing tab) ───────────────────
// A custom override, once set, if present — otherwise the live
// watchlist+portfolio union. This is the ONE function everything (Briefing's
// preview, the newsletter subscribe form, auto-resync) should read the
// digest's symbol list from, so customizing it in one place is honored
// everywhere.
export function getDigestSymbols() {
  try {
    const raw = localStorage.getItem(CUSTOM_SYMBOLS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* fall through to the live default */
  }
  return distinctSymbols();
}

export function hasCustomDigestSymbols() {
  try {
    return localStorage.getItem(CUSTOM_SYMBOLS_KEY) != null;
  } catch {
    return false;
  }
}

function setDigestSymbols(list) {
  try {
    localStorage.setItem(CUSTOM_SYMBOLS_KEY, JSON.stringify(list));
  } catch {
    /* private mode — edits just won't persist across reloads */
  }
}

export function addDigestSymbol(entry) {
  if (!entry?.market || !entry?.symbol) return getDigestSymbols();
  const cur = getDigestSymbols();
  const key = `${entry.market}:${String(entry.symbol).toUpperCase()}`;
  if (cur.some((s) => `${s.market}:${String(s.symbol).toUpperCase()}` === key)) return cur;
  const next = [...cur, { market: entry.market, symbol: String(entry.symbol).toUpperCase(), name: entry.name || entry.symbol }];
  setDigestSymbols(next);
  return next;
}

export function removeDigestSymbol(market, symbol) {
  const next = getDigestSymbols().filter(
    (s) => !(s.market === market && String(s.symbol).toUpperCase() === String(symbol).toUpperCase())
  );
  setDigestSymbols(next);
  return next;
}

// Undo any customization — go back to always following the live
// watchlist/portfolio, same as before the builder existed.
export function resetDigestSymbols() {
  try {
    localStorage.removeItem(CUSTOM_SYMBOLS_KEY);
  } catch {
    /* ignore */
  }
}

// Shared POST — used by both the debounced auto-resync and the builder's
// explicit "Save" action. Returns a reason string on failure so callers can
// show the user something meaningful instead of failing silently.
async function postSymbols(target, symbols) {
  try {
    const res = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: target.email, prefs: { ...target.prefs, symbols } }),
    });
    if (!res.ok) return { ok: false, reason: "request_failed" };
    const data = await res.json().catch(() => ({}));
    if ("mailed" in data) { clearDigestSyncTarget(); return { ok: false, reason: "unsubscribed" }; }
    saveDigestSyncTarget({ email: target.email, prefs: target.prefs, symbols });
    return { ok: true };
  } catch {
    return { ok: false, reason: "offline" };
  }
}

async function resyncNow(target) {
  const symbols = getDigestSymbols();
  const symbolsJSON = JSON.stringify(symbols);
  if (symbolsJSON === target.lastSymbolsJSON) return; // nothing actually changed
  await postSymbols(target, symbols);
}

// Explicit "push my current digest builder list to the actual subscription"
// action — the Briefing tab's "Save to my digest email" button. Unlike
// resyncNow this always posts (it's a deliberate action, not a background
// catch-up check) and reports back so the UI can confirm or explain failure.
export async function saveDigestSymbolsNow() {
  const target = loadTarget();
  if (!target) return { ok: false, reason: "not_subscribed" };
  return postSymbols(target, getDigestSymbols());
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
