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
const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Expected a JavaScript-or-Wasm module script/i;
const RECOVER_KEY = "quant_chunk_recover";

async function recoverFromStaleChunks() {
  try {
    if (sessionStorage.getItem(RECOVER_KEY)) return false; // already tried this session
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
          <p style={{ color: "#6b7280", fontSize: 14, lineHeight: 1.6, marginBottom: 20 }}>
            The rest of the app is fine. Reload the page, or go back to the dashboard.
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
