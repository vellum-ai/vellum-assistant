/**
 * Hook that orchestrates terminal I/O: SSE stream subscription, input
 * batching, resize debouncing, and auto-reconnect with exponential backoff.
 *
 * State lives in {@link useTerminalStore}; this hook drives transitions
 * by calling store actions in response to I/O events.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  createTerminalSession,
  destroyTerminalSession,
  resizeTerminal,
  sendTerminalInput,
  subscribeTerminalEvents,
  type TerminalOutputStream,
} from "@/domains/terminal/api";
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

  useEffect(() => {
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
      sendTerminalInput(assistantId, sessionId, buffered).catch(() => {});
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
        const session = await createTerminalSession(assistantId, apiOptions);
        sessionId = session.sessionId;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create terminal session";
        if (isReconnect) useTerminalStore.getState().reconnectFailed(message);
        else useTerminalStore.getState().connectFailed(message);
        return;
      }

      const expected = isReconnect ? "reconnecting" : "connecting";
      if (useTerminalStore.getState().status !== expected) {
        destroyTerminalSession(assistantId, sessionId).catch(() => {});
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
        resizeTerminal(assistantId, sessionId, dims.cols, dims.rows).catch(() => {});
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
        destroyTerminalSession(assistantId, prevSessionId).catch(() => {});
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
      destroyTerminalSession(assistantId, sessionId).catch(() => {});
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
      destroyTerminalSession(assistantId, sessionId).catch(() => {});
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
        resizeTerminal(assistantId, current.sessionId, pending.cols, pending.rows).catch(() => {});
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
        destroyTerminalSession(assistantId, sessionId).catch(() => {});
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
