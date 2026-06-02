/**
 * SSE transport for terminal PTY output.
 *
 * The terminal events endpoint is not in the platform OpenAPI spec (it's a
 * raw SSE stream), so there is no generated SDK function for it. This module
 * provides the subscription primitive that {@link useTerminalSession} drives.
 */

import { client as platformClient } from "@/generated/api/client.gen";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single SSE event emitted by the terminal output stream. */
export interface TerminalOutputEvent {
  /** Monotonically-increasing sequence number used to deduplicate/order output. */
  seq: number;
  /** Base64-encoded PTY output bytes (VT100/xterm escape sequences). */
  data: string;
}

export interface TerminalOutputStream {
  /** Cancel the stream. Safe to call multiple times. */
  cancel: () => void;
}

// ---------------------------------------------------------------------------
// SSE subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to the terminal SSE output stream.
 *
 * Events are delivered in order of arrival. Callers are responsible for
 * deduplicating / ordering by `seq` if reconnecting.
 *
 * Returns a handle with a `cancel()` method to tear down the stream.
 */
export function subscribeTerminalEvents(
  assistantId: string,
  sessionId: string,
  onEvent: (event: TerminalOutputEvent) => void,
  onError: (err: Error) => void,
): TerminalOutputStream {
  let cancelled = false;
  const abortController = new AbortController();

  const cancel = () => {
    cancelled = true;
    abortController.abort();
  };

  const connect = async () => {
    if (cancelled) return;

    let streamError: Error | null = null;
    try {
      const { stream } = await platformClient.sse.get<
        Record<string, unknown> | string
      >({
        url: "/v1/assistants/{assistant_id}/terminal/sessions/{session_id}/events/",
        path: { assistant_id: assistantId, session_id: sessionId },
        headers: {
          Accept: "text/event-stream, application/json",
          ...getClientRegistrationHeaders(),
        },
        signal: abortController.signal,
        sseMaxRetryAttempts: 3,
        onSseError: (error) => {
          streamError =
            error instanceof Error
              ? error
              : new Error("Terminal stream disconnected");
        },
      });

      for await (const payload of stream) {
        if (cancelled) return;

        const raw =
          typeof payload === "string"
            ? (() => {
                try {
                  const parsed = JSON.parse(payload);
                  return parsed &&
                    typeof parsed === "object" &&
                    !Array.isArray(parsed)
                    ? (parsed as Record<string, unknown>)
                    : null;
                } catch {
                  return null;
                }
              })()
            : payload && typeof payload === "object" && !Array.isArray(payload)
              ? (payload as Record<string, unknown>)
              : null;

        if (!raw) continue;

        // Support envelope format: { message: { seq, data } }
        let eventData = raw;
        if (
          raw.message &&
          typeof raw.message === "object" &&
          !Array.isArray(raw.message)
        ) {
          eventData = raw.message as Record<string, unknown>;
        }

        const seq = typeof eventData.seq === "number" ? eventData.seq : -1;
        const data = typeof eventData.data === "string" ? eventData.data : "";

        if (seq < 0 || data === "") continue;

        try {
          onEvent({ seq, data });
        } catch {
          // Callback errors should not abort the stream
        }
      }

      if (cancelled) return;

      if (streamError) {
        onError(streamError);
        return;
      }

      onError(new Error("Terminal stream ended unexpectedly"));
    } catch (err) {
      if (cancelled) return;
      onError(
        err instanceof Error
          ? err
          : new Error("Terminal stream connection failed"),
      );
    }
  };

  connect().catch((err) => {
    if (!cancelled) {
      onError(
        err instanceof Error ? err : new Error("Terminal stream setup failed"),
      );
    }
  });

  return { cancel };
}
