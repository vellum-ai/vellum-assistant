import * as React from "react";

import type { ClientConfig } from "../types";

interface AppProps {
  config: ClientConfig;
}

export function App({ config }: AppProps): React.ReactElement {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(circle at top, #1a1033 0%, #060214 70%)",
        color: "#e8e6f5",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <div style={{ maxWidth: "32rem" }}>
        <div
          style={{
            fontSize: "3.5rem",
            lineHeight: 1,
            marginBottom: "1.5rem",
          }}
          aria-hidden
        >
          🚀
        </div>
        <h1
          style={{
            fontSize: "2rem",
            fontWeight: 600,
            margin: "0 0 0.75rem",
            letterSpacing: "-0.02em",
          }}
        >
          Vellum web client
        </h1>
        <p
          style={{
            fontSize: "1rem",
            lineHeight: 1.6,
            margin: "0 0 1.5rem",
            color: "#bdb6d8",
          }}
        >
          The rest of the UI will be here soon. For now, this is the placeholder
          shell — the server is running and you&rsquo;re wired up.
        </p>
        <code
          style={{
            display: "inline-block",
            fontSize: "0.8rem",
            padding: "0.4rem 0.65rem",
            borderRadius: "0.4rem",
            background: "rgba(255, 255, 255, 0.06)",
            color: "#a39dc4",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          }}
        >
          api: {config.apiBase}
        </code>
      </div>
    </main>
  );
}
