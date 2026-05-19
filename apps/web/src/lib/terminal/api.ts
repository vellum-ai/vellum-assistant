import { client as internalClient } from "@/generated/api/client.gen.js";
import {
  assistantsTerminalSessionsCreate,
  assistantsTerminalSessionsDestroy,
  assistantsTerminalSessionsInputCreate,
  assistantsTerminalSessionsResizeCreate,
} from "@/generated/api/sdk.gen.js";
import { getClientRegistrationHeaders } from "@/lib/telemetry/client-identity.js";

// Configure the HeyAPI client (CSRF + Vellum-Organization-Id interceptors)
import "@/lib/vellum-api/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalSession {
  sessionId: string;
}

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

/**
 * Options shared by all terminal API functions.
 * When `admin` is true the request is routed through the admin-scoped
 * endpoints (`/v1/admin/assistants/…`) which do not require the caller
 * to own the assistant.
 */
export interface TerminalApiOptions {
  admin?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

// ---------------------------------------------------------------------------
// Create / destroy
// ---------------------------------------------------------------------------

/**
 * Open a new terminal session for the given assistant.
 * Returns the opaque session ID assigned by the backend.
 */
export async function createTerminalSession(
  assistantId: string,
  options?: TerminalApiOptions & { service?: string },
): Promise<TerminalSession> {
  let data: unknown;
  let error: unknown;
  let response: Response | undefined;

  const body = options?.service ? { service: options.service } : undefined;

  if (options?.admin) {
    const result = await assistantsTerminalSessionsCreate({
      path: { assistant_id: assistantId },
      body,
      throwOnError: false,
    });
    data = result.data;
    error = result.error;
    response = result.response;
  } else {
    const result = await assistantsTerminalSessionsCreate({
      path: { assistant_id: assistantId },
      body,
      throwOnError: false,
    });
    data = result.data;
    error = result.error;
    response = result.response;
  }

  if (!response?.ok) {
    const detail =
      error && typeof error === "object" && !Array.isArray(error)
        ? ((error as Record<string, unknown>).detail as string | undefined)
        : undefined;
    throw new Error(detail ?? `Failed to create terminal session (HTTP ${response?.status})`);
  }

  const raw =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const sessionId =
    typeof raw.session_id === "string"
      ? raw.session_id
      : typeof raw.id === "string"
        ? raw.id
        : undefined;

  if (!sessionId) {
    throw new Error("Backend did not return a session ID");
  }

  return { sessionId };
}

/**
 * Close a terminal session and release backend resources.
 * Errors are swallowed — callers should treat close as best-effort.
 */
export async function destroyTerminalSession(
  assistantId: string,
  sessionId: string,
  options?: TerminalApiOptions,
): Promise<void> {
  try {
    if (options?.admin) {
      await assistantsTerminalSessionsDestroy({
        path: { assistant_id: assistantId, session_id: sessionId },
        throwOnError: false,
      });
    } else {
      await assistantsTerminalSessionsDestroy({
        path: { assistant_id: assistantId, session_id: sessionId },
        throwOnError: false,
      });
    }
  } catch {
    // Best-effort cleanup — ignore errors on close
  }
}

// ---------------------------------------------------------------------------
// Input / resize
// ---------------------------------------------------------------------------

/**
 * Send keyboard input bytes to the PTY stdin.
 * `data` should be the raw key sequence (e.g. "\r" for Enter).
 */
export async function sendTerminalInput(
  assistantId: string,
  sessionId: string,
  data: string,
  options?: TerminalApiOptions,
): Promise<void> {
  let response: Response | undefined;

  if (options?.admin) {
    const result = await assistantsTerminalSessionsInputCreate({
      path: { assistant_id: assistantId, session_id: sessionId },
      body: { data },
      throwOnError: false,
    });
    response = result.response;
  } else {
    const result = await assistantsTerminalSessionsInputCreate({
      path: { assistant_id: assistantId, session_id: sessionId },
      body: { data },
      throwOnError: false,
    });
    response = result.response;
  }

  if (!response?.ok) {
    throw new Error(`Failed to send terminal input (HTTP ${response?.status})`);
  }
}

/**
 * Notify vembda of a PTY window resize.
 */
export async function resizeTerminal(
  assistantId: string,
  sessionId: string,
  cols: number,
  rows: number,
  options?: TerminalApiOptions,
): Promise<void> {
  let response: Response | undefined;

  if (options?.admin) {
    const result = await assistantsTerminalSessionsResizeCreate({
      path: { assistant_id: assistantId, session_id: sessionId },
      body: { cols, rows },
      throwOnError: false,
    });
    response = result.response;
  } else {
    const result = await assistantsTerminalSessionsResizeCreate({
      path: { assistant_id: assistantId, session_id: sessionId },
      body: { cols, rows },
      throwOnError: false,
    });
    response = result.response;
  }

  if (!response?.ok) {
    throw new Error(`Failed to resize terminal (HTTP ${response?.status})`);
  }
}

// ---------------------------------------------------------------------------
// SSE output stream
// ---------------------------------------------------------------------------

/**
 * Subscribe to the terminal SSE output stream.
 *
 * Events are delivered in order of arrival.  Callers are responsible for
 * deduplicating / ordering by `seq` if reconnecting.
 *
 * Returns a handle with a `cancel()` method to tear down the stream.
 */
export function subscribeTerminalEvents(
  assistantId: string,
  sessionId: string,
  onEvent: (event: TerminalOutputEvent) => void,
  onError: (err: Error) => void,
  options?: TerminalApiOptions,
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
      const sseClient = options?.admin ? internalClient : internalClient;
      const { stream } = await sseClient.sse.get<Record<string, unknown> | string>({
        ...SDK_BASE_OPTIONS,
        url: options?.admin
          ? "/v1/admin/assistants/{assistant_id}/terminal/sessions/{session_id}/events/"
          : "/v1/assistants/{assistant_id}/terminal/sessions/{session_id}/events/",
        path: { assistant_id: assistantId, session_id: sessionId },
        headers: {
          Accept: "text/event-stream, application/json",
          ...getClientRegistrationHeaders(),
        },
        signal: abortController.signal,
        sseMaxRetryAttempts: 3,
        onSseError: (error: unknown) => {
          streamError = error instanceof Error
            ? error
            : new Error("Terminal stream disconnected");
        },
      });

      for await (const payload of stream) {
        if (cancelled) return;

        // Parse the raw SSE payload into a typed terminal output event.
        const raw =
          typeof payload === "string"
            ? (() => {
              try {
                const parsed = JSON.parse(payload);
                return parsed && typeof parsed === "object" && !Array.isArray(parsed)
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
      onError(err instanceof Error ? err : new Error("Terminal stream connection failed"));
    }
  };

  connect().catch((err) => {
    if (!cancelled) {
      onError(err instanceof Error ? err : new Error("Terminal stream setup failed"));
    }
  });

  return { cancel };
}
