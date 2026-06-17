/**
 * Self-contained workspace terminal panel. Opens an interactive shell in a
 * self-hosted assistant's workspace via the Electron main-process `node-pty`
 * manager (which runs `vellum exec -it`). Manages its own connection lifecycle
 * — mount it with an `assistantId` and it handles connect/disconnect,
 * input/output, and resize.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { TerminalConsole } from "@/domains/terminal/components/terminal-console";
import { TerminalToolbar } from "@/domains/terminal/components/terminal-toolbar";
import type { TerminalStatus } from "@/domains/terminal/types";
import {
  killLocalTerminal,
  onLocalTerminalData,
  onLocalTerminalExit,
  openLocalTerminal,
  resizeLocalTerminal,
  writeLocalTerminal,
} from "@/runtime/local-terminal";

interface LocalTerminalPanelProps {
  /** Self-hosted assistant whose workspace the shell opens in. */
  assistantId: string;
  /** Target service within the assistant (default: "assistant"). */
  service?: string;
  className?: string;
}

export function LocalTerminalPanel({
  assistantId,
  service,
  className,
}: LocalTerminalPanelProps) {
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const writeToTerminalRef = useRef<((data: string) => void) | null>(null);
  const mountedRef = useRef(true);
  const pendingDimensionsRef = useRef<{ cols: number; rows: number } | null>(
    null,
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const id = sessionIdRef.current;
      if (id) {
        void killLocalTerminal(id);
        sessionIdRef.current = null;
      }
    };
  }, []);

  // Subscribe to PTY data/exit events
  useEffect(() => {
    const unsubData = onLocalTerminalData((sessionId, data) => {
      if (sessionId !== sessionIdRef.current) {
        return;
      }
      writeToTerminalRef.current?.(data);
    });

    const unsubExit = onLocalTerminalExit((sessionId) => {
      if (sessionId !== sessionIdRef.current) {
        return;
      }
      sessionIdRef.current = null;
      setStatus("closed");
    });

    return () => {
      unsubData();
      unsubExit();
    };
  }, []);

  const connect = useCallback(async () => {
    const prev = sessionIdRef.current;
    if (prev) {
      await killLocalTerminal(prev);
      sessionIdRef.current = null;
    }

    setStatus("connecting");
    setErrorMessage(null);

    const dims = pendingDimensionsRef.current ?? undefined;
    const result = await openLocalTerminal({
      assistantId,
      service,
      cols: dims?.cols,
      rows: dims?.rows,
    });

    if (!mountedRef.current) {
      if (result.ok) {
        void killLocalTerminal(result.sessionId);
      }
      return;
    }

    if (!result.ok) {
      setStatus("error");
      setErrorMessage(result.error);
      return;
    }

    sessionIdRef.current = result.sessionId;
    setStatus("connected");

    if (dims) {
      resizeLocalTerminal(result.sessionId, dims.cols, dims.rows);
    }
  }, [assistantId, service]);

  const disconnect = useCallback(async () => {
    const id = sessionIdRef.current;
    if (id) {
      await killLocalTerminal(id);
      sessionIdRef.current = null;
    }
    setStatus("closed");
  }, []);

  const handleConsoleData = useCallback((data: string) => {
    const id = sessionIdRef.current;
    if (id) {
      writeLocalTerminal(id, data);
    }
  }, []);

  const handleConsoleResize = useCallback(
    ({ cols, rows }: { cols: number; rows: number }) => {
      pendingDimensionsRef.current = { cols, rows };
      const id = sessionIdRef.current;
      if (id) {
        resizeLocalTerminal(id, cols, rows);
      }
    },
    [],
  );

  const handleClear = useCallback(() => {
    writeToTerminalRef.current?.("\x1b[2J\x1b[H");
  }, []);

  const handleConnect = useCallback(() => {
    void connect();
  }, [connect]);

  const isReadOnly = status !== "connected";

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
        onDisconnect={disconnect}
        onClear={handleClear}
      />

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
