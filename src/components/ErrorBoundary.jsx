import { Component } from "react";

// Global error boundary — a render error in any page used to blank the whole
// app (the white-screen class we hit before). Now it shows a recovery card and
// keeps the shell alive. Logs to the console so the error is still visible in
// dev; a future monitoring hook can forward it.

// A failed dynamic import is NOT a code bug — it means the browser holds a
// stale/poisoned entry for a chunk URL (e.g. index.html cached as a module after
// a mid-deploy race, which then fails MIME checking). The page is unusable but
// self-fixable: drop the caches and reload once. Guarded by sessionStorage so a
// genuinely missing chunk can never become a reload loop.
// Broad on purpose — browsers word a failed chunk load half a dozen ways (network
// fetch, MIME mismatch when the 404 falls back to index.html, Safari/Firefox
// variants). Missing one meant the auto-recovery never fired and the user saw the
// error card after a deploy. The reload is guarded to one shot, so casting wide is safe.
const CHUNK_ERROR = /dynamically imported module|module script|Importing a module|disallowed MIME type|ChunkLoadError|Loading chunk|Failed to fetch/i;
const RECOVER_KEY = "quant_chunk_recover";
// The guard is a COOLDOWN, not a one-shot. It used to be "already tried this
// session", and sessionStorage lives as long as the tab: a tab left open across
// several deploys healed itself once and then showed the error card forever,
// because every later deploy found the flag already set. A cooldown still makes
// a reload loop impossible (a genuinely broken chunk can't recover twice within
// the window) while letting each new deploy heal.
const RECOVER_COOLDOWN_MS = 20_000;

async function recoverFromStaleChunks() {
  try {
    const last = Number(sessionStorage.getItem(RECOVER_KEY) || 0);
    if (Date.now() - last < RECOVER_COOLDOWN_MS) return false; // just tried — don't loop
    sessionStorage.setItem(RECOVER_KEY, String(Date.now()));
  } catch { /* private mode — still worth one reload */ }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* ignore */ }
  // Cache-busting param forces a revalidated document + fresh module graph.
  const url = new URL(window.location.href);
  url.searchParams.set("_r", Date.now().toString(36));
  window.location.replace(url.toString());
  return true;
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, recovering: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("Uncaught render error:", error, info?.componentStack);
    if (CHUNK_ERROR.test(String(error?.message || error))) {
      this.setState({ recovering: true });
      recoverFromStaleChunks().then((did) => { if (!did) this.setState({ recovering: false }); });
    }
  }

  render() {
    if (this.state.recovering) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", color: "#6b7280", fontSize: 14 }}>
          Updating to the latest version…
        </div>
      );
    }
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <div style={{ maxWidth: 460, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong on this page</h1>
          <p style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6, marginBottom: 12 }}>
            The rest of the app is fine. Reload the page, or go back to the dashboard.
          </p>
          {/* Show WHAT broke. A bare "something went wrong" is undiagnosable —
              neither the user nor I could tell a stale chunk from a real bug. */}
          <p style={{ color: "#9ca3af", fontSize: 11, fontFamily: "ui-monospace, monospace", lineHeight: 1.5, marginBottom: 20, wordBreak: "break-word" }}>
            {String(this.state.error?.message || this.state.error).slice(0, 200)}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button onClick={() => window.location.reload()}
              style={{ padding: "10px 18px", borderRadius: 8, border: "none", background: "#111827", color: "#fff", fontSize: 14, cursor: "pointer" }}>
              Reload
            </button>
            <button onClick={() => { window.location.href = "/"; }}
              style={{ padding: "10px 18px", borderRadius: 8, border: "1px solid #d1d5db", background: "transparent", color: "inherit", fontSize: 14, cursor: "pointer" }}>
              Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
