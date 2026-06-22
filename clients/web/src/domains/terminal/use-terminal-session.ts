/**
 * Hook that orchestrates terminal I/O: SSE stream subscription, input
 * batching, resize debouncing, and auto-reconnect with exponential backoff.
 *
 * State lives in {@link useTerminalStore}; this hook drives transitions
 * by calling store actions in response to I/O events.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import {
  assistantsTerminalSessionsCreate,
  assistantsTerminalSessionsDestroy,
  assistantsTerminalSessionsInputCreate,
  assistantsTerminalSessionsResizeCreate,
} from "@/generated/api/sdk.gen";
import {
  subscribeTerminalEvents,
  type TerminalOutputStream,
} from "@/domains/terminal/terminal-stream";
import { useTerminalStore } from "@/domains/terminal/terminal-store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INPUT_FLUSH_INTERVAL_MS = 50;
const RESIZE_DEBOUNCE_MS = 150;
const MAX_AUTO_RECONNECT_ATTEMPTS = 3;
const AUTO_RECONNECT_BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Output de-duplication
// ---------------------------------------------------------------------------

interface SeqTracker {
  highWaterMark: number;
}

function createSeqTracker(): SeqTracker {
  return { highWaterMark: -1 };
}

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------

export interface UseTerminalSessionArgs {
  assistantId: string | null;
  onData: (data: string) => void;
  service?: string;
}

export interface UseTerminalSessionResult {
  connect: () => void;
  reconnect: () => void;
  close: () => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTerminalSession({
  assistantId,
  onData,
  service,
}: UseTerminalSessionArgs): UseTerminalSessionResult {
  const streamRef = useRef<TerminalOutputStream | null>(null);
  const onDataRef = useRef(onData);

  useLayoutEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  // Input batching
  const inputBufferRef = useRef<string>("");
  const inputFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resize debounce
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);

  // Sequence tracker for deduplication
  const seqTrackerRef = useRef<SeqTracker>(createSeqTracker());

  // Auto-reconnect timer
  const autoReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Whether the session was intentionally closed by the user
  const userClosedRef = useRef(false);

  // Tracks the last session ID so auto-reconnect can destroy the previous
  // session even after errorOccurred clears sessionId from state.
  const lastSessionIdRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Input flush
  // ---------------------------------------------------------------------------

  const apiOptions = useMemo(
    () => (service ? { service } : undefined),
    [service],
  );

  const startInputFlushTimer = useCallback((sessionId: string) => {
    if (inputFlushTimerRef.current) return;
    inputFlushTimerRef.current = setInterval(() => {
      const buffered = inputBufferRef.current;
      if (!buffered || !assistantId) return;
      inputBufferRef.current = "";
      assistantsTerminalSessionsInputCreate({ path: { assistant_id: assistantId, session_id: sessionId }, body: { data: buffered }, throwOnError: false }).catch(() => {});
    }, INPUT_FLUSH_INTERVAL_MS);
  }, [assistantId]);

  const stopInputFlushTimer = useCallback(() => {
    if (inputFlushTimerRef.current) {
      clearInterval(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }
    inputBufferRef.current = "";
  }, []);

  // ---------------------------------------------------------------------------
  // Core connect logic
  // ---------------------------------------------------------------------------

  const openSession = useCallback(
    async (isReconnect: boolean) => {
      if (!assistantId) {
        if (isReconnect) useTerminalStore.getState().reconnectFailed("No assistant ID");
        else useTerminalStore.getState().connectFailed("No assistant ID");
        return;
      }

      let sessionId: string;
      try {
        const { data, error, response } = await assistantsTerminalSessionsCreate({
          path: { assistant_id: assistantId },
          body: apiOptions,
          throwOnError: false,
        });

        if (!response || !response.ok) {
          const detail =
            error && typeof error === "object" && !Array.isArray(error)
              ? ((error as Record<string, unknown>).detail as string | undefined)
              : undefined;
          throw new Error(
            detail ?? `Failed to create terminal session (HTTP ${response?.status ?? "unknown"})`,
          );
        }

        const raw =
          data && typeof data === "object" && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : {};
        const sid =
          typeof raw.session_id === "string"
            ? raw.session_id
            : typeof raw.id === "string"
              ? raw.id
              : undefined;

        if (!sid) {
          throw new Error("Backend did not return a session ID");
        }
        sessionId = sid;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create terminal session";
        if (isReconnect) useTerminalStore.getState().reconnectFailed(message);
        else useTerminalStore.getState().connectFailed(message);
        return;
      }

      const expected = isReconnect ? "reconnecting" : "connecting";
      if (useTerminalStore.getState().status !== expected) {
        assistantsTerminalSessionsDestroy({ path: { assistant_id: assistantId, session_id: sessionId }, throwOnError: false }).catch(() => {});
        return;
      }

      seqTrackerRef.current = createSeqTracker();

      const stream = subscribeTerminalEvents(
        assistantId,
        sessionId,
        (event) => {
          if (event.seq <= seqTrackerRef.current.highWaterMark) return;
          seqTrackerRef.current.highWaterMark = event.seq;
          try {
            onDataRef.current(event.data);
          } catch {
            // Callback errors should not affect the stream
          }
        },
        (err) => {
          stopInputFlushTimer();
          useTerminalStore.getState().errorOccurred(err.message);
        },
      );

      streamRef.current = stream;
      startInputFlushTimer(sessionId);

      userClosedRef.current = false;
      lastSessionIdRef.current = sessionId;

      if (isReconnect) useTerminalStore.getState().reconnectSucceeded(sessionId);
      else useTerminalStore.getState().connectSucceeded(sessionId);

      const dims = lastDimensionsRef.current;
      if (dims && assistantId) {
        assistantsTerminalSessionsResizeCreate({ path: { assistant_id: assistantId, session_id: sessionId }, body: { cols: dims.cols, rows: dims.rows }, throwOnError: false }).catch(() => {});
      }
    },
    [assistantId, apiOptions, startInputFlushTimer, stopInputFlushTimer],
  );

  // ---------------------------------------------------------------------------
  // Auto-reconnect on stream error
  // ---------------------------------------------------------------------------

  const status = useTerminalStore.use.status();
  const reconnectAttempts = useTerminalStore.use.reconnectAttempts();

  useEffect(() => {
    if (status !== "error") return;
    if (userClosedRef.current) return;
    if (reconnectAttempts >= MAX_AUTO_RECONNECT_ATTEMPTS) return;

    const delay = AUTO_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts;
    autoReconnectTimerRef.current = setTimeout(() => {
      autoReconnectTimerRef.current = null;
      const current = useTerminalStore.getState();
      if (current.status !== "error" || userClosedRef.current) return;

      streamRef.current?.cancel();
      streamRef.current = null;

      const prevSessionId = lastSessionIdRef.current;
      if (prevSessionId && assistantId) {
        lastSessionIdRef.current = null;
        assistantsTerminalSessionsDestroy({ path: { assistant_id: assistantId, session_id: prevSessionId }, throwOnError: false }).catch(() => {});
      }

      useTerminalStore.getState().requestReconnect();
      openSession(true);
    }, delay);

    return () => {
      if (autoReconnectTimerRef.current) {
        clearTimeout(autoReconnectTimerRef.current);
        autoReconnectTimerRef.current = null;
      }
    };
  }, [status, reconnectAttempts, assistantId, openSession]);

  // ---------------------------------------------------------------------------
  // Public actions
  // ---------------------------------------------------------------------------

  const connect = useCallback(() => {
    const { status: s } = useTerminalStore.getState();
    if (s !== "idle" && s !== "closed" && s !== "error") return;
    useTerminalStore.getState().requestConnect();
    openSession(false);
  }, [openSession]);

  const reconnect = useCallback(() => {
    const { status: s, sessionId } = useTerminalStore.getState();
    if (s !== "error" && s !== "connected") return;

    streamRef.current?.cancel();
    streamRef.current = null;
    stopInputFlushTimer();

    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    pendingResizeRef.current = null;

    if (sessionId && assistantId) {
      assistantsTerminalSessionsDestroy({ path: { assistant_id: assistantId, session_id: sessionId }, throwOnError: false }).catch(() => {});
    }

    useTerminalStore.getState().requestReconnect();
    openSession(true);
  }, [assistantId, openSession, stopInputFlushTimer]);

  const close = useCallback(() => {
    const { sessionId } = useTerminalStore.getState();

    userClosedRef.current = true;

    if (autoReconnectTimerRef.current) {
      clearTimeout(autoReconnectTimerRef.current);
      autoReconnectTimerRef.current = null;
    }

    streamRef.current?.cancel();
    streamRef.current = null;
    stopInputFlushTimer();

    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }

    if (sessionId && assistantId) {
      assistantsTerminalSessionsDestroy({ path: { assistant_id: assistantId, session_id: sessionId }, throwOnError: false }).catch(() => {});
    }

    useTerminalStore.getState().closed();
  }, [assistantId, stopInputFlushTimer]);

  const sendInput = useCallback((data: string) => {
    inputBufferRef.current += data;
  }, []);

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      lastDimensionsRef.current = { cols, rows };

      const { status: s, sessionId } = useTerminalStore.getState();
      if (s !== "connected" || !sessionId || !assistantId) return;

      pendingResizeRef.current = { cols, rows };

      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        const pending = pendingResizeRef.current;
        const current = useTerminalStore.getState();
        if (!pending || !current.sessionId || current.status !== "connected" || !assistantId) return;
        pendingResizeRef.current = null;
        assistantsTerminalSessionsResizeCreate({ path: { assistant_id: assistantId, session_id: current.sessionId }, body: { cols: pending.cols, rows: pending.rows }, throwOnError: false }).catch(() => {});
      }, RESIZE_DEBOUNCE_MS);
    },
    [assistantId],
  );

  // ---------------------------------------------------------------------------
  // Cleanup on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      userClosedRef.current = true;

      if (autoReconnectTimerRef.current) {
        clearTimeout(autoReconnectTimerRef.current);
        autoReconnectTimerRef.current = null;
      }

      streamRef.current?.cancel();
      streamRef.current = null;

      if (inputFlushTimerRef.current) {
        clearInterval(inputFlushTimerRef.current);
        inputFlushTimerRef.current = null;
      }

      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }

      const { sessionId } = useTerminalStore.getState();
      if (sessionId && assistantId) {
        assistantsTerminalSessionsDestroy({ path: { assistant_id: assistantId, session_id: sessionId }, throwOnError: false }).catch(() => {});
      }

      useTerminalStore.getState().reset();
    };
  }, [assistantId]);

  return {
    connect,
    reconnect,
    close,
    sendInput,
    sendResize,
  };
}
