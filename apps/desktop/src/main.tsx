import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./tokens.css";
import "./app.css";
import { App } from "./App.tsx";

/** A render crash should explain itself, not leave a blank window. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rf-boot" role="alert">
        <h1>Something went wrong in the editor</h1>
        <p>{this.state.error.message}</p>
        <p>Your project is safe: every edit is saved by the engine as it happens. Reload the window to continue.</p>
        <button className="rf-btn" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
