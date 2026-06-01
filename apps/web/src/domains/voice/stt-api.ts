import { sttTranscribePost } from "@/generated/daemon/sdk.gen";
import { SDK_BASE_OPTIONS } from "@/utils/api-errors";

export interface SttTranscribeOk {
  status: "ok";
  text: string;
  providerId: string;
  boundaryId?: string;
}

/**
 * Reasons the daemon's STT pipeline can fail. Mirrors the categories returned
 * by `normalizeSttError` in `assistant/src/stt/daemon-batch-transcriber.ts`,
 * with the addition of `network` for transport-level failures that never
 * reached the daemon.
 */
export type SttFailureReason =
  | "config-missing"
  | "audio-rejected"
  | "auth-failed"
  | "rate-limited"
  | "provider-error"
  | "unavailable"
  | "timeout"
  | "network"
  | "aborted"
  | "unknown";

export interface SttTranscribeFailure {
  status: "error";
  reason: SttFailureReason;
  /** HTTP status code, when the request reached the daemon. */
  httpStatus?: number;
  /** Daemon-supplied error detail, when present. */
  message?: string;
}

export type SttTranscribeOutcome = SttTranscribeOk | SttTranscribeFailure;

/**
 * Map a daemon HTTP response to a structured failure reason. The daemon's
 * route handler maps `SttErrorCategory` → `RouteError` subclasses with
 * specific HTTP statuses (see `assistant/src/runtime/routes/stt-routes.ts`),
 * so the inverse mapping is well-defined.
 *
 * 503 has two distinguishable sub-cases that the user can act on differently:
 * `"No speech-to-text provider is configured"` (the assistant owner needs to
 * pick a provider in Settings) vs `"STT provider is not available"`
 * (transient — retry).
 */
function reasonFromHttp(
  status: number,
  message: string | undefined,
): SttFailureReason {
  switch (status) {
    case 400:
      return "audio-rejected";
    case 401:
    case 403:
      return "auth-failed";
    case 429:
      return "rate-limited";
    case 502:
      return "provider-error";
    case 503: {
      const text = (message ?? "").toLowerCase();
      if (text.includes("not configured") || text.includes("no speech-to-text"))
        return "config-missing";
      return "unavailable";
    }
    case 504:
      return "timeout";
    default:
      return "unknown";
  }
}

/** Best-effort extraction of the daemon's textual error detail.
 *
 * The daemon's `httpError()` wraps errors in `{ error: { code, message } }`.
 * Some proxy layers (e.g. Django DRF) use `{ detail: "..." }` instead.
 * This function handles both shapes.
 */
function extractMessage(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["detail", "message"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    // Recurse into `{ error: { message: "..." } }` envelope from httpError().
    if (record.error && typeof record.error === "object") {
      return extractMessage(record.error);
    }
  }
  return undefined;
}

/**
 * POST /v1/stt/transcribe
 *
 * Sends a recorded audio blob to the daemon's STT provider for transcription
 * and returns a discriminated outcome so callers can surface category-specific
 * UI (`config-missing` → "set up STT in Settings", `audio-rejected` → "try
 * again", `rate-limited` → "wait and retry", etc.) instead of a single
 * opaque failure code.
 *
 * Uses the same session auth (cookies + Vellum-Organization-Id header) as all
 * other /v1/ routes — no special JWT required.
 *
 * TODO(atlas): Once the Velay WebSocket service supports browser WS upgrades
 * through the managed gateway, replace this batch call with a streaming
 * connection to WS /v1/stt/stream for live interim transcript feedback.
 */
export async function postSttTranscribe(
  audioBlob: Blob,
  assistantId: string,
  signal?: AbortSignal,
): Promise<SttTranscribeOutcome> {
  // Convert Blob → base64. Using a manual loop avoids the call-stack
  // overflow that btoa(String.fromCharCode(...spread)) can hit on large buffers.
  const arrayBuffer = await audioBlob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < uint8.length; i += chunkSize) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
  }
  const audioBase64 = btoa(binary);

  // The HeyAPI client with `throwOnError: false` does NOT throw on transport
  // failures (AbortError, DNS, offline, CORS) — it resolves with
  // `{ error, request, response: undefined }`. We must inspect `result.error`
  // and `result.response` directly to categorise these; the surrounding
  // try/catch only fires on developer errors thrown synchronously inside the
  // request setup. See `@/generated/daemon/client.gen`.
  let result: Awaited<ReturnType<typeof sttTranscribePost>>;
  try {
    result = await sttTranscribePost({
      ...SDK_BASE_OPTIONS,
      path: { assistant_id: assistantId },
      body: {
        audioBase64,
        mimeType: audioBlob.type,
        source: "dictation",
      },
      throwOnError: false,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { status: "error", reason: "aborted" };
    }
    console.warn("postSttTranscribe: client error", err);
    return { status: "error", reason: "network" };
  }

  const response: Response | undefined = result.response;

  if (!response) {
    const err = result.error;
    if (err instanceof DOMException && err.name === "AbortError") {
      return { status: "error", reason: "aborted" };
    }
    // Some browsers / abort polyfills surface aborts as plain objects with
    // `.name === "AbortError"` rather than `DOMException` instances.
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "AbortError"
    ) {
      return { status: "error", reason: "aborted" };
    }
    console.warn("postSttTranscribe: transport error (no response)", err);
    return { status: "error", reason: "network" };
  }

  if (response.ok) {
    const ok = result.data;
    return {
      status: "ok",
      text: ok?.text ?? "",
      providerId: ok?.providerId ?? "",
      boundaryId: ok?.boundaryId,
    };
  }

  // On non-ok responses the heyapi client parses the error body and puts it
  // on `result.error` — `result.data` is undefined. The daemon distinguishes
  // 503 sub-cases via the body text ("No speech-to-text provider is
  // configured" → config-missing vs the generic "STT provider is not
  // available" → unavailable), so we must read the message from `error`.
  const message = extractMessage(result.error);
  const reason = reasonFromHttp(response.status, message);
  console.warn(
    `postSttTranscribe: HTTP ${response.status} (${reason})${
      message ? `: ${message}` : ""
    }`,
  );
  return { status: "error", reason, httpStatus: response.status, message };
}
