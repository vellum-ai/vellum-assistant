/**
 * Per-request outbound diagnostics for LLM provider calls.
 *
 * Diagnosing a provider failure requires knowing what the client actually put
 * on the wire: the resolved URL and path, the model ID sent, the connection
 * whose credential was used, the HTTP status, and the verbatim upstream error
 * body. Provider SDKs surface only a fraction of that (`@google/genai`'s
 * `ApiError` carries a status and a message and nothing else), and error
 * normalization collapses the rest, so "404 with an empty body" and "body
 * dropped on the way here" become indistinguishable.
 *
 * A recorder is bound to the async context for the duration of one provider
 * call. Layers that own a fact write it as they learn it (the routing wrapper
 * knows the connection, the provider client knows the model), and the outbound
 * `fetch` instrumentation records the URL, status, and error body observed on
 * the actual request. Nothing here is re-derived from config.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether a raw upstream error body was captured, and if not, why. Callers
 * must be able to tell an upstream that answered with no body from one whose
 * body never reached the diagnostics layer, and those point at different bugs.
 */
export type UpstreamErrorBodyState =
  | "captured"
  | "empty"
  | "truncated"
  | "unavailable";

/** Wire-shaped (snake_case) evidence surfaced to diagnostics consumers. */
export interface ProviderRequestDiagnostics {
  /** Full outbound URL including path, with credential material redacted. */
  resolved_url?: string;
  /** Model ID as sent to the provider, not as requested by the caller. */
  model_id?: string;
  /** `provider_connections` row whose credential authenticated the request. */
  connection_name?: string;
  /** HTTP status of the outbound response. */
  http_status?: number;
  /** Verbatim upstream error body for a non-2xx response. */
  upstream_error_body?: string;
  upstream_error_body_state?: UpstreamErrorBodyState;
  /** Byte length of the upstream error body before any truncation. */
  upstream_error_body_bytes?: number;
}

/**
 * Ceiling on a retained error body. Bodies are recorded verbatim below it;
 * above it the prefix is kept, the state is `truncated`, and the true length
 * is reported in `upstream_error_body_bytes`, so a large HTML error page can
 * neither be mistaken for an empty body nor exhaust memory.
 */
const MAX_ERROR_BODY_BYTES = 1_048_576;

/**
 * Query parameters that carry credential material. Gemini sends the API key as
 * `?key=`, so a URL is only safe to surface after these are masked.
 */
const CREDENTIAL_QUERY_PARAMS = new Set([
  "key",
  "api_key",
  "apikey",
  "access_token",
  "token",
]);

const REDACTED = "REDACTED";

/** Mask credential material in a URL so it can be recorded and displayed. */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username) {
    parsed.username = REDACTED;
  }
  if (parsed.password) {
    parsed.password = REDACTED;
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (CREDENTIAL_QUERY_PARAMS.has(name.toLowerCase())) {
      parsed.searchParams.set(name, REDACTED);
    }
  }
  return parsed.toString();
}

class DiagnosticsRecorder {
  private readonly diagnostics: ProviderRequestDiagnostics = {};

  record(patch: ProviderRequestDiagnostics): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        Object.assign(this.diagnostics, { [key]: value });
      }
    }
  }

  snapshot(): ProviderRequestDiagnostics {
    return { ...this.diagnostics };
  }
}

const recorderStorage = new AsyncLocalStorage<DiagnosticsRecorder>();

/**
 * Record what is known about the in-flight provider request. A no-op outside a
 * {@link runWithProviderRequestDiagnostics} scope, so call sites on hot paths
 * do not need to branch.
 */
export function recordProviderRequestDiagnostics(
  patch: ProviderRequestDiagnostics,
): void {
  recorderStorage.getStore()?.record(patch);
}

/**
 * Run `fn` with a diagnostics recorder bound to its async context and return
 * everything observed, whether `fn` resolved or threw. The failure path is the
 * one that matters: a probe reports the URL and upstream body of the request
 * that failed.
 */
export async function runWithProviderRequestDiagnostics<T>(
  fn: () => Promise<T>,
): Promise<
  | { ok: true; value: T; diagnostics: ProviderRequestDiagnostics }
  | { ok: false; error: unknown; diagnostics: ProviderRequestDiagnostics }
> {
  installOutboundHttpDiagnostics();
  const recorder = new DiagnosticsRecorder();
  return recorderStorage.run(recorder, async () => {
    try {
      const value = await fn();
      return { ok: true as const, value, diagnostics: recorder.snapshot() };
    } catch (error) {
      return { ok: false as const, error, diagnostics: recorder.snapshot() };
    }
  });
}

let installed = false;

/**
 * Wrap `globalThis.fetch` so outbound requests made inside a diagnostics scope
 * report their resolved URL, status, and raw non-2xx body. Instrumenting the
 * global is what makes this uniform across provider SDKs: `@google/genai`
 * offers no `fetch` injection point and exposes neither URL nor body on its
 * errors. Outside a scope the wrapper delegates untouched, and error bodies
 * are read from a `clone()` so the SDK's own read is unaffected.
 */
export function installOutboundHttpDiagnostics(): void {
  if (installed) {
    return;
  }
  installed = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function instrumentedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const recorder = recorderStorage.getStore();
    if (!recorder) {
      return originalFetch(input, init);
    }
    const url = requestUrl(input);
    try {
      const response = await originalFetch(input, init);
      recorder.record({
        ...(url ? { resolved_url: redactUrl(url) } : {}),
        http_status: response.status,
      });
      if (!response.ok) {
        recorder.record(await readErrorBody(response));
      }
      return response;
    } catch (error) {
      if (url) {
        recorder.record({ resolved_url: redactUrl(url) });
      }
      throw error;
    }
  } as typeof globalThis.fetch;
}

function requestUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return typeof input?.url === "string" ? input.url : undefined;
}

async function readErrorBody(
  response: Response,
): Promise<ProviderRequestDiagnostics> {
  let body: string;
  try {
    body = await response.clone().text();
  } catch {
    return { upstream_error_body_state: "unavailable" };
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes === 0) {
    return { upstream_error_body_state: "empty", upstream_error_body_bytes: 0 };
  }
  if (bytes > MAX_ERROR_BODY_BYTES) {
    return {
      upstream_error_body: body.slice(0, MAX_ERROR_BODY_BYTES),
      upstream_error_body_state: "truncated",
      upstream_error_body_bytes: bytes,
    };
  }
  return {
    upstream_error_body: body,
    upstream_error_body_state: "captured",
    upstream_error_body_bytes: bytes,
  };
}
