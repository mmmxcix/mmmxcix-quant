import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { applyThemePrefs } from "./lib/themeSettings";
import "./index.css";
import "./glass.css";

// Re-assert the saved chart colours + dither level (the index.html snippet
// applies them pre-paint; this keeps React the source of truth too).
applyThemePrefs();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
