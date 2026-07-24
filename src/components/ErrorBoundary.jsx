import { Component } from "react";

// Global error boundary — a render error in any page used to blank the whole
// app (the white-screen class we hit before). Now it shows a recovery card and
// keeps the shell alive. Logs to the console so the error is still visible in
// dev; a future monitoring hook can forward it.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("Uncaught render error:", error, info?.componentStack);
  }

  render() {
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
