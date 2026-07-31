import { useCallback, useRef } from "react";

import type { MaintenanceMode } from "@/generated/api/types.gen";
import { useTerminalSession } from "@/domains/terminal/use-terminal-session";
import { useTerminalStore } from "@/domains/terminal/terminal-store";
import { TerminalConsole } from "@/domains/terminal/components/terminal-console";
import { TerminalToolbar } from "@/domains/terminal/components/terminal-toolbar";

export interface TerminalPanelProps {
  assistantId: string | null;
  className?: string;
  maintenanceMode?: MaintenanceMode;
  service?: string;
}

export function TerminalPanel({
  assistantId,
  className,
  maintenanceMode,
  service,
}: TerminalPanelProps) {
  const writeToTerminalRef = useRef<((data: string) => void) | null>(null);

  const handleData = useCallback((data: string) => {
    try {
      const decoded = atob(data);
      writeToTerminalRef.current?.(decoded);
    } catch {
      writeToTerminalRef.current?.(data);
    }
  }, []);

  const { connect, close, sendInput, sendResize, reconnect } =
    useTerminalSession({ assistantId, onData: handleData, service });

  const status = useTerminalStore.use.status();
  const errorMessage = useTerminalStore.use.errorMessage();
  const reconnectAttempts = useTerminalStore.use.reconnectAttempts();

  const handleConnect = useCallback(() => {
    if (
      status === "error" ||
      status === "reconnecting" ||
      reconnectAttempts > 0
    ) {
      reconnect();
    } else {
      connect();
    }
  }, [status, reconnectAttempts, connect, reconnect]);

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
    writeToTerminalRef.current?.("\x1b[2J\x1b[H");
  }, []);

  const isReadOnly = status !== "connected";
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
        status={status}
        onConnect={handleConnect}
        onDisconnect={close}
        onClear={handleClear}
        maintenanceModeActive={isMaintenanceActive}
      />

      {isMaintenanceActive && (
        <div className="border-b border-[var(--system-mid-strong)] bg-[var(--system-mid-weak)] px-3 py-2 text-body-small-default text-[var(--system-mid-strong)]">
          Recovery Mode active — this session is connected to the debug
          terminal.
        </div>
      )}

      {status === "error" && errorMessage && (
        <div className="border-b border-[var(--border-base)] bg-[var(--system-negative-weak)] px-3 py-2 text-body-small-default text-[var(--system-negative-strong)]">
          {errorMessage}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <TerminalConsole
            onData={handleConsoleData}
            onResize={handleConsoleResize}
            readOnly={isReadOnly}
            writeRef={writeToTerminalRef}
            className="h-full w-full"
          />
        </div>
      </div>
    </div>
  );
}
