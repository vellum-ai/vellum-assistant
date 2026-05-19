
import { useCallback, useRef } from "react";

import type { MaintenanceMode } from "@/generated/api/types.gen.js";
import { useTerminalSession } from "@/lib/terminal/use-terminal-session.js";
import { TerminalConsole } from "@/components/shared/terminal/terminal-console.js";
import { TerminalToolbar } from "@/components/shared/terminal/terminal-toolbar.js";

export interface TerminalPanelProps {
  /** The assistant ID that terminal sessions will be opened against. */
  assistantId: string | null;
  /** Optional CSS class for the outermost container. */
  className?: string;
  /** When true, route API calls through admin-scoped terminal endpoints. */
  admin?: boolean;
  /**
   * Optional maintenance mode metadata. When provided and enabled, the
   * terminal chrome shows a notice that the session targets the debug pod.
   * The connect/disconnect transport flow is unchanged.
   */
  maintenanceMode?: MaintenanceMode;
  /**
   * Target container service name (e.g. "assistant", "gateway",
   * "credential-executor"). Controls which sidecar the terminal session
   * attaches to. Defaults to "assistant".
   */
  service?: string;
}

/**
 * TerminalPanel composes TerminalConsole, TerminalToolbar, and
 * useTerminalSession into a self-contained terminal widget that can be
 * embedded in any page context (settings, assistant chat, etc.).
 *
 * Session lifecycle (connect / disconnect / cleanup) is managed internally —
 * callers only need to provide an assistantId.
 */
export function TerminalPanel({ assistantId, className, admin, maintenanceMode, service }: TerminalPanelProps) {
  // writeToTerminal is populated by TerminalConsole once xterm is initialised.
  const writeToTerminalRef = useRef<((data: string) => void) | null>(null);

  const handleData = useCallback((data: string) => {
    // PTY output arrives as base64-encoded bytes. Decode and write to xterm.
    try {
      const decoded = atob(data);
      writeToTerminalRef.current?.(decoded);
    } catch {
      // If decoding fails try writing raw — best-effort.
      writeToTerminalRef.current?.(data);
    }
  }, []);

  const { terminalState, connect, close, sendInput, sendResize, reconnect } =
    useTerminalSession({ assistantId, onData: handleData, admin, service });

  const handleConnect = useCallback(() => {
    const { status, reconnectAttempts } = terminalState;
    // Always use reconnect() when in error or reconnecting state — it safely
    // cancels any lingering stream via streamRef.current?.cancel() before
    // opening a new one. Using connect() here would skip that teardown and
    // leak the old stream (especially after RECONNECT_SUCCEEDED resets
    // reconnectAttempts to 0).
    if (
      status === "error" ||
      status === "reconnecting" ||
      reconnectAttempts > 0
    ) {
      reconnect();
    } else {
      connect();
    }
  }, [terminalState, connect, reconnect]);

  const handleConsoleData = useCallback(
    (data: string) => {
      sendInput(data);
    },
    [sendInput],
  );

  const handleConsoleResize = useCallback(
    ({ cols, rows }: { cols: number; rows: number }) => {
      sendResize(cols, rows);
    },
    [sendResize],
  );

  const handleClear = useCallback(() => {
    // Write a clear escape sequence to the local xterm buffer.
    // The PTY buffer on the backend is unaffected.
    writeToTerminalRef.current?.("\x1b[2J\x1b[H");
  }, []);

  const isReadOnly = terminalState.status !== "connected";
  const isMaintenanceActive = maintenanceMode?.enabled === true;

  return (
    <div
      className={[
        "flex flex-col overflow-hidden rounded-lg border border-[var(--border-base)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <TerminalToolbar
        status={terminalState.status}
        onConnect={handleConnect}
        onDisconnect={close}
        onClear={handleClear}
        maintenanceModeActive={isMaintenanceActive}
      />

      {isMaintenanceActive && (
        <div className="border-b border-[var(--system-mid-strong)] bg-[var(--system-mid-weak)] px-3 py-2 text-body-small-default text-[var(--system-mid-strong)] dark:border-[var(--system-mid-strong)] dark:bg-[var(--system-mid-weak)] dark:text-[var(--system-mid-strong)]">
          Recovery Mode active — this session is connected to the debug terminal.
        </div>
      )}

      {terminalState.status === "error" && terminalState.errorMessage && (
        <div className="border-b border-[var(--border-base)] bg-[var(--system-negative-weak)] px-3 py-2 text-body-small-default text-[var(--system-negative-strong)] dark:border-[var(--border-base)] dark:bg-[var(--system-negative-weak)] dark:text-[var(--system-negative-strong)]">
          {terminalState.errorMessage}
        </div>
      )}

      {/* Relative wrapper gives xterm a definitively-sized container so
          fitAddon.fit() always measures correct cols/rows regardless of
          how the flex chain resolves. The ring provides the interior border. */}
      <div className="flex-1 min-h-0 relative ring-1 ring-inset ring-[color-mix(in_srgb,var(--content-secondary)_40%,transparent)]">
        <TerminalConsole
          className="absolute inset-0"
          onData={handleConsoleData}
          onResize={handleConsoleResize}
          readOnly={isReadOnly}
          writeRef={writeToTerminalRef}
        />
      </div>
    </div>
  );
}
