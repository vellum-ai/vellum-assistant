import React from "react";
import ReactDOM from "react-dom/client";

import "./styles.css";

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("Eli HUD render error", error, info);
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          height: "100vh",
          width: "100vw",
          background: "#02060c",
          color: "#ff9f55",
          fontFamily: "monospace",
          padding: "16px",
          boxSizing: "border-box",
          whiteSpace: "pre-wrap",
        }}
      >
        {`Eli UI failed to render.\n\n${this.state.error.message}`}
      </div>
    );
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Eli HUD: missing #root element");
}
const rootContainer: HTMLElement = rootEl;
const bootStatusEl = document.getElementById("boot-status");
let didBootUi = false;

window.addEventListener("error", (event) => {
  if (!didBootUi) {
    const message = event.error instanceof Error ? event.error.message : event.message;
    showFatal(`Eli UI bootstrap error:\n\n${message}`);
    return;
  }
  console.error("Eli HUD runtime error", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  if (!didBootUi) {
    const reason =
      event.reason instanceof Error
        ? event.reason.message
        : typeof event.reason === "string"
          ? event.reason
          : "Unknown rejection";
    showFatal(`Eli UI unhandled rejection:\n\n${reason}`);
    return;
  }
  console.error("Eli HUD unhandled rejection", event.reason);
});

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function showFatal(message: string): void {
  if (bootStatusEl) bootStatusEl.remove();
  document.body.innerHTML = `<div style="height:100vh;width:100vw;background:#02060c;color:#ff4d6d;font-family:monospace;padding:16px;box-sizing:border-box;white-space:pre-wrap;">${escapeHtml(message)}</div>`;
}

async function bootstrap(): Promise<void> {
  try {
    const { App } = await import("./App.js");
    if (bootStatusEl) bootStatusEl.remove();
    didBootUi = true;
    ReactDOM.createRoot(rootContainer).render(
      <React.StrictMode>
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </React.StrictMode>,
    );
  } catch (err) {
    const message =
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : typeof err === "string"
          ? err
          : "Unknown bootstrap failure";
    showFatal(`Eli failed to import UI modules:\n\n${message}`);
  }
}

void bootstrap();
