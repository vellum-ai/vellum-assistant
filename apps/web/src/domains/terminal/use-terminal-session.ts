
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import {
  createTerminalSession,
  destroyTerminalSession,
  resizeTerminal,
  sendTerminalInput,
  subscribeTerminalEvents,
  type TerminalOutputStream,
} from "@/domains/terminal/api.js";

import {
  INITIAL_TERMINAL_STATE,
  terminalReducer,
  type TerminalState,
} from "@/domains/terminal/use-terminal-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Interval at which batched keyboard input is flushed to the backend.
 * Buffering reduces POST volume for rapid typing.
 */
const INPUT_FLUSH_INTERVAL_MS = 50;

/**
 * Debounce delay for resize events — only the last resize within this window
 * is sent to reduce request volume during drag-resizing.
 */
const RESIZE_DEBOUNCE_MS = 150;

/** Maximum number of automatic reconnection attempts before giving up. */
const MAX_AUTO_RECONNECT_ATTEMPTS = 3;

/** Base delay (ms) for exponential backoff between auto-reconnect attempts. */
const AUTO_RECONNECT_BASE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Output de-duplication
// ---------------------------------------------------------------------------

/**
 * Tracks the highest sequence number seen on the current stream so that
 * duplicate or out-of-order events (e.g. after reconnect) are dropped.
 */
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
  /**
   * Called with each new chunk of PTY output as it arrives.
   * The caller is responsible for writing this to the xterm terminal instance.
   * `data` is a base64-encoded string of raw VT100/xterm bytes.
   */
  onData: (data: string) => void;
  /**
   * Target container service name (e.g. "assistant", "gateway",
   * "credential-executor"). Sent to the backend so `open_pod_exec_stream`
   * attaches to the right container. Omit for the default
   * (assistant-container).
   */
  service?: string;
}

export interface UseTerminalSessionResult {
  terminalState: TerminalState;
  /** Open a terminal session and start streaming output. */
  connect: () => void;
  /** Manually reconnect (tears down existing session first). */
  reconnect: () => void;
  /** Close the terminal session cleanly. */
  close: () => void;
  /**
   * Send keyboard input to the PTY.
   * Input is buffered and flushed on a short interval to reduce POST volume.
   */
  sendInput: (data: string) => void;
  /**
   * Notify the backend of a terminal window resize.
   * Updates are debounced to reduce request volume.
   */
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
  const [terminalState, dispatch] = useReducer(terminalReducer, INITIAL_TERMINAL_STATE);

  // Stable ref so event handlers can read latest state without stale closures.
  const stateRef = useRef(terminalState);

  useEffect(() => {
    stateRef.current = terminalState;
  }, [terminalState]);

  // Active SSE stream handle.
  const streamRef = useRef<TerminalOutputStream | null>(null);

  // onData callback via ref to avoid recreating effects on every render.
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

  // Last known terminal dimensions — updated on every resize callback so we
  // can send the correct size to the PTY immediately after session connect.
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);

  // Sequence tracker for deduplication — reset on each new session.
  const seqTrackerRef = useRef<SeqTracker>(createSeqTracker());

  // Auto-reconnect timer — cleared on unmount or manual close.
  const autoReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Whether the session was intentionally closed by the user (suppresses auto-reconnect).
  const userClosedRef = useRef(false);

  // Tracks the last session ID so auto-reconnect can destroy the previous
  // session even after ERROR_OCCURRED clears sessionId from state.
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
      sendTerminalInput(assistantId, sessionId, buffered).catch(() => {
        // Best-effort — lost keystrokes are acceptable over a crash
      });
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
        dispatch({ type: isReconnect ? "RECONNECT_FAILED" : "CONNECT_FAILED", message: "No assistant ID" });
        return;
      }

      // Create backend session
      let sessionId: string;
      try {
        const session = await createTerminalSession(assistantId, apiOptions);
        sessionId = session.sessionId;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create terminal session";
        dispatch({ type: isReconnect ? "RECONNECT_FAILED" : "CONNECT_FAILED", message });
        return;
      }

      // Reset seq tracker for this fresh session
      seqTrackerRef.current = createSeqTracker();

      // Subscribe to the SSE output stream
      const stream = subscribeTerminalEvents(
        assistantId,
        sessionId,
        (event) => {
          // Drop duplicate / out-of-order events
          if (event.seq <= seqTrackerRef.current.highWaterMark) return;
          seqTrackerRef.current.highWaterMark = event.seq;
          try {
            onDataRef.current(event.data);
          } catch {
            // Callback errors should not affect the stream
          }
        },
        (err) => {
          // Surface the error so callers can reconnect.
          // ERROR_OCCURRED transitions from any state to error with the actual
          // message, which is more useful than the generic "Connection lost."
          // that DISCONNECTED would produce.
          stopInputFlushTimer();
          dispatch({ type: "ERROR_OCCURRED", message: err.message });
        },
      );

      streamRef.current = stream;

      // Start input batching
      startInputFlushTimer(sessionId);

      // Successful connection resets the user-closed flag.
      userClosedRef.current = false;

      lastSessionIdRef.current = sessionId;

      dispatch({
        type: isReconnect ? "RECONNECT_SUCCEEDED" : "CONNECT_SUCCEEDED",
        sessionId,
      });

      // Flush the last known terminal dimensions to the PTY so that the
      // backend column/row count matches what xterm.js is rendering.
      // Without this, the initial resize fired by fitAddon.fit() before the
      // session was connected is silently dropped, leaving the PTY at its
      // default size (e.g. 80×24) which causes incorrect text wrapping.
      const dims = lastDimensionsRef.current;
      if (dims && assistantId) {
        resizeTerminal(assistantId, sessionId, dims.cols, dims.rows).catch(() => {
          // Best-effort — resize failures are non-critical
        });
      }
    },
    [assistantId, apiOptions, startInputFlushTimer, stopInputFlushTimer],
  );

  // ---------------------------------------------------------------------------
  // Auto-reconnect on stream error
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (terminalState.status !== "error") return;
    if (userClosedRef.current) return;
    if (terminalState.reconnectAttempts >= MAX_AUTO_RECONNECT_ATTEMPTS) return;

    const delay = AUTO_RECONNECT_BASE_DELAY_MS * 2 ** terminalState.reconnectAttempts;
    autoReconnectTimerRef.current = setTimeout(() => {
      autoReconnectTimerRef.current = null;
      const current = stateRef.current;
      if (current.status !== "error" || userClosedRef.current) return;

      // Tear down any leftover stream.
      streamRef.current?.cancel();
      streamRef.current = null;

      // ERROR_OCCURRED clears sessionId from state, so use the ref instead.
      const prevSessionId = lastSessionIdRef.current;
      if (prevSessionId && assistantId) {
        lastSessionIdRef.current = null;
        destroyTerminalSession(assistantId, prevSessionId).catch(() => {});
      }

      dispatch({ type: "RECONNECT_REQUESTED" });
      openSession(true);
    }, delay);

    return () => {
      if (autoReconnectTimerRef.current) {
        clearTimeout(autoReconnectTimerRef.current);
        autoReconnectTimerRef.current = null;
      }
    };
  }, [terminalState.status, terminalState.reconnectAttempts, assistantId, openSession]);

  // ---------------------------------------------------------------------------
  // Public actions
  // ---------------------------------------------------------------------------

  const connect = useCallback(() => {
    const status = stateRef.current.status;
    if (status !== "idle" && status !== "closed" && status !== "error") return;
    dispatch({ type: "CONNECT_REQUESTED" });
    openSession(false);
  }, [openSession]);

  const reconnect = useCallback(() => {
    const { status, sessionId } = stateRef.current;
    if (status !== "error" && status !== "connected") return;

    // Tear down existing session/stream first
    streamRef.current?.cancel();
    streamRef.current = null;
    stopInputFlushTimer();

    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
    pendingResizeRef.current = null;

    if (sessionId && assistantId) {
      destroyTerminalSession(assistantId, sessionId).catch(() => {
        // Best-effort
      });
    }

    dispatch({ type: "RECONNECT_REQUESTED" });
    openSession(true);
  }, [assistantId, openSession, stopInputFlushTimer]);

  const close = useCallback(() => {
    const { sessionId } = stateRef.current;

    // Mark as intentionally closed so auto-reconnect does not fire.
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
      destroyTerminalSession(assistantId, sessionId).catch(() => {
        // Best-effort cleanup
      });
    }

    dispatch({ type: "TERMINAL_CLOSED" });
  }, [assistantId, stopInputFlushTimer]);

  const sendInput = useCallback((data: string) => {
    // Buffer keystrokes; the interval flush sends them in batches
    inputBufferRef.current += data;
  }, []);

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      // Always track latest dimensions so we can flush them on connect.
      lastDimensionsRef.current = { cols, rows };

      const { status, sessionId } = stateRef.current;
      if (status !== "connected" || !sessionId || !assistantId) return;

      pendingResizeRef.current = { cols, rows };

      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
      }
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        const pending = pendingResizeRef.current;
        const currentSessionId = stateRef.current.sessionId;
        const currentStatus = stateRef.current.status;
        if (!pending || !currentSessionId || currentStatus !== "connected" || !assistantId) return;
        pendingResizeRef.current = null;
        resizeTerminal(assistantId, currentSessionId, pending.cols, pending.rows).catch(() => {
          // Best-effort — resize failures are non-critical
        });
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

      const { sessionId } = stateRef.current;
      if (sessionId && assistantId) {
        destroyTerminalSession(assistantId, sessionId).catch(() => {
          // Best-effort cleanup on unmount
        });
      }
    };
  }, []);

  return {
    terminalState,
    connect,
    reconnect,
    close,
    sendInput,
    sendResize,
  };
}
