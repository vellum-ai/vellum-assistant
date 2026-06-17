/**
 * SSE transport for terminal PTY output.
 *
 * The terminal events endpoint is not in the platform OpenAPI spec (it's a
 * raw SSE stream), so there is no generated SDK function for it. This module
 * provides the subscription primitive that {@link useTerminalSession} drives.
 */

import { client as platformClient } from "@/generated/api/client.gen";
import { normalizeSSEPayload, unwrapMessageEnvelope } from "@/lib/streaming/sse-payload";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity";
import { toError } from "@/utils/to-error";

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
        // All retry behavior is owned by useTerminalSession's
        // reconnect state machine — SDK-level retries would be
        // invisible to the consumer's status tracking.
        sseMaxRetryAttempts: 0,
        onSseError: (error) => {
          streamError = toError(error, "Terminal stream disconnected");
        },
      });

      for await (const payload of stream) {
        if (cancelled) return;

        const raw = normalizeSSEPayload(payload);
        if (!raw) continue;

        const eventData = unwrapMessageEnvelope(raw);

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
      onError(toError(err, "Terminal stream connection failed"));
    }
  };

  connect().catch((err) => {
    if (!cancelled) {
      onError(toError(err, "Terminal stream setup failed"));
    }
  });

  return { cancel };
}
