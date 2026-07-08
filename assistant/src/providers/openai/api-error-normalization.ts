import type OpenAI from "openai";

import type { ProviderErrorReason } from "../../util/errors.js";

/**
 * Normalized view of an OpenAI-compatible `APIError`. The SDK reads
 * `error.message` and renders bodies it can't parse as "(no body)", so
 * Django `{"detail": "..."}` payloads from the managed runtime proxy and
 * OpenRouter's nested `error.metadata.raw` get dropped. We capture the raw
 * non-2xx body in a `fetch` wrapper and reconstruct the useful fields here.
 */
export interface NormalizedOpenAIAPIError {
  message: string;
  detail?: string;
  requestId?: string;
  apiErrorCode?: string;
  apiErrorType?: string;
  apiErrorParam?: string;
  /**
   * The captured raw upstream non-2xx body, verbatim (possibly truncated to
   * MAX_CAPTURED_BODY_CHARS). Carried so callers can persist the actual
   * provider payload for the inspector's Raw tab instead of only the
   * extracted fields. Absent for retryable (429/5xx) errors, whose bodies
   * `captureRawErrorBodyFetch` intentionally doesn't drain.
   */
  rawBody?: string;
  /**
   * Semantic failure classification derived from status + body signals by
   * {@link deriveReason}. The OpenAI-compat throw sites forward it onto the
   * thrown `ProviderError.reason` so downstream classification/retry can switch
   * on intent rather than re-deriving from status/regex.
   */
  reason?: ProviderErrorReason;
}

// Vision-not-supported prose. A minimal local copy of the daemon-layer
// VISION_NOT_SUPPORTED_PATTERNS — providers must not import from the daemon.
const VISION_UNSUPPORTED_PATTERNS = [
  /no endpoints found that support image input/i,
  /does not support image/i,
  /doesn't support image input/i,
  /image input is not supported/i,
  /this model does not support vision/i,
  /vision is not supported/i,
  /multi-?modal.*not.*support/i,
];

/**
 * Map an OpenAI-compatible error to a semantic {@link ProviderErrorReason}.
 * Order matters — the model-restriction check precedes the generic 401/403
 * credential branch, and billing precedes credentials.
 */
export function deriveReason(
  n: NormalizedOpenAIAPIError,
  status: number | undefined,
): ProviderErrorReason {
  const haystack = `${n.message} ${n.detail ?? ""} ${n.rawBody ?? ""}`;

  if (
    status === 403 &&
    (n.apiErrorType === "no_providers_available" ||
      n.apiErrorParam === "RestrictedModelsError" ||
      /RestrictedModelsError/i.test(haystack) ||
      /do(?:es)? ?n[o']t have access to this model/i.test(haystack))
  ) {
    return "model_restricted";
  }

  if (
    /model .*(?:not found|does not exist)/i.test(haystack) ||
    /model_not_found/i.test(`${n.apiErrorCode ?? ""} ${n.apiErrorType ?? ""}`)
  ) {
    return "model_not_found";
  }

  if (VISION_UNSUPPORTED_PATTERNS.some((re) => re.test(haystack))) {
    return "vision_unsupported";
  }

  if (
    status === 402 ||
    /credit balance is too low/i.test(haystack) ||
    /insufficient.*credits?/i.test(haystack)
  ) {
    return "insufficient_credits";
  }

  if (status === 401 || status === 403) return "invalid_credentials";
  if (status === 429) return "rate_limited";
  if (status === 529 || /overloaded/i.test(haystack)) return "overloaded";
  if (status !== undefined && status >= 500) return "server_error";
  if (status !== undefined && status >= 400) return "bad_request";
  return "unknown";
}

const MAX_DETAIL_CHARS = 2000;
const REQUEST_ID_HEADERS = [
  "x-request-id",
  "x-openrouter-request-id",
  "openai-request-id",
  "x-amzn-requestid",
] as const;

// The OpenAI SDK keeps only the `.error` key of a parsed JSON error body and
// discards the rest, so a Django-proxy `{ "detail": … }` payload never reaches
// the thrown APIError. captureRawErrorBodyFetch stashes the raw body in a
// WeakMap keyed by the response's headers object — which the SDK passes through
// to `APIError.headers` by reference — so it stays correlated to its own
// request, with no shared provider state for concurrent calls to clobber. A
// WeakMap (rather than a synthetic header) keeps the body out of the SDK's
// debug header logging and is reclaimed automatically with the response.
const capturedErrorBodies = new WeakMap<object, string>();
// Bound the stored body so a huge HTML error page can't balloon memory; the
// message is re-truncated to MAX_DETAIL_CHARS downstream anyway.
const MAX_CAPTURED_BODY_CHARS = 16_384;

/**
 * SDK `fetch` option that captures non-2xx response bodies. Install via the
 * OpenAI client `fetch` option; safe to share across requests and instances
 * because the captured body is keyed per-response in a WeakMap, not stored on
 * any shared field.
 */
export const captureRawErrorBodyFetch = async (
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const res = await globalThis.fetch(url, init);
  if (res.ok) return res;
  // Don't drain bodies the SDK will retry: reading a large or slow upstream
  // error page on every attempt would delay those retries and buffer the whole
  // body. We still capture terminal (non-retryable) errors — that's where the
  // actionable upstream detail lives (unsupported model, invalid key, malformed
  // request, etc.).
  if (sdkWillRetry(res)) return res;
  // clone() so reading the body leaves the SDK's own read of `res` intact.
  const body = await res
    .clone()
    .text()
    .catch(() => undefined);
  if (!body) return res;
  capturedErrorBodies.set(
    res.headers,
    body.length > MAX_CAPTURED_BODY_CHARS
      ? body.slice(0, MAX_CAPTURED_BODY_CHARS)
      : body,
  );
  return res;
};

/**
 * Mirror the OpenAI SDK's `shouldRetry` predicate so this wrapper never drains
 * a body the SDK is about to retry. The SDK retries more than 429/5xx: an
 * explicit `x-should-retry` header (which also overrides 429/5xx to *not*
 * retry), plus 408 (request timeout) and 409 (lock timeout). Keep in sync with
 * `openai/client.js` `shouldRetry`.
 */
function sdkWillRetry(res: Response): boolean {
  const shouldRetryHeader = res.headers.get("x-should-retry");
  if (shouldRetryHeader === "true") return true;
  if (shouldRetryHeader === "false") return false;
  return (
    res.status === 408 ||
    res.status === 409 ||
    res.status === 429 ||
    res.status >= 500
  );
}

export function normalizeOpenAIAPIError(
  error: InstanceType<typeof OpenAI.APIError>,
  rawBody: string | undefined = readCapturedErrorBody(error.headers),
): NormalizedOpenAIAPIError {
  // Prefer the captured raw body (intact upstream payload) over the SDK's
  // already-parsed `error.error`, which may have collapsed the detail. But if
  // the captured body didn't parse as a JSON object — e.g. it was truncated
  // past MAX_CAPTURED_BODY_CHARS into an invalid prefix — fall back to the
  // SDK's parsed object so we don't drop code/type/param it already extracted.
  const parsedRaw = parseBody(rawBody);
  const sdkError = (error as { error?: unknown }).error;
  const parsed = asRecord(parsedRaw) ?? sdkError ?? parsedRaw;
  const body = extractBody(parsed);

  const message =
    body.message ||
    stripLeadingStatus(error.message ?? "", error.status) ||
    "Request failed";

  const out: NormalizedOpenAIAPIError = { message };
  if (body.detail && body.detail !== message) out.detail = body.detail;
  const code = body.apiErrorCode ?? scalar((error as { code?: unknown }).code);
  const type = body.apiErrorType ?? scalar((error as { type?: unknown }).type);
  const param =
    body.apiErrorParam ?? scalar((error as { param?: unknown }).param);
  if (code) out.apiErrorCode = code;
  if (type) out.apiErrorType = type;
  if (param) out.apiErrorParam = param;
  const requestId = readHeader(error.headers);
  if (requestId) out.requestId = requestId;
  if (rawBody) out.rawBody = rawBody;
  out.reason = deriveReason(out, error.status);
  return out;
}

export function formatNormalizedOpenAIAPIError(
  providerLabel: string,
  status: number | undefined,
  n: NormalizedOpenAIAPIError,
): string {
  const statusLabel =
    typeof status === "number" ? String(status) : "unknown status";
  const extras = [
    n.detail,
    n.apiErrorCode && `code=${n.apiErrorCode}`,
    n.apiErrorType && `type=${n.apiErrorType}`,
    n.apiErrorParam && `param=${n.apiErrorParam}`,
    n.requestId && `request_id=${n.requestId}`,
  ].filter((v): v is string => Boolean(v));
  const suffix = extras.length > 0 ? ` [${extras.join("; ")}]` : "";
  return `${providerLabel} API error (${statusLabel}): ${n.message}${suffix}`;
}

interface BodyDetails {
  message?: string;
  detail?: string;
  apiErrorCode?: string;
  apiErrorType?: string;
  apiErrorParam?: string;
}

function extractBody(body: unknown): BodyDetails {
  if (typeof body === "string") return { message: trunc(body.trim()) };
  const rec = asRecord(body);
  if (!rec) return {};

  // OpenAI/OpenRouter nest under `error`; Django puts `detail` at the top.
  // A plain `error: "string"` is the whole message but may still carry
  // sibling code/type/param, so fall through to the metadata extraction below.
  const err = asRecord(rec.error) ?? rec;

  let message =
    str(rec.error) ?? str(err.message) ?? str(err.detail) ?? str(rec.detail);
  let detail: string | undefined;

  // OpenRouter: the real downstream error lives in metadata.raw while the
  // top-level message is a generic "Provider returned error".
  const meta = asRecord(err.metadata);
  const raw = str(meta?.raw);
  const provider = str(meta?.provider_name);
  if (raw && message && /^provider returned error$/i.test(message)) {
    message = raw;
  } else if (raw && raw !== message) {
    detail = raw;
  }
  if (provider) {
    detail = detail
      ? `${detail}; provider=${provider}`
      : `provider=${provider}`;
  }

  return {
    ...(message ? { message: trunc(message) } : {}),
    ...(detail ? { detail: trunc(detail) } : {}),
    ...withScalar("apiErrorCode", err.code ?? rec.code),
    ...withScalar("apiErrorType", err.type ?? rec.type),
    ...withScalar("apiErrorParam", err.param ?? rec.param),
  };
}

function parseBody(raw: string | undefined): unknown {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed; // non-JSON body (HTML error page, plain text)
  }
}

function stripLeadingStatus(
  message: string,
  status: number | undefined,
): string {
  const trimmed = message.trim();
  // SDK sentinel for an unparseable/empty body — carries no signal, so let the
  // caller fall back to "Request failed" rather than surface SDK phrasing.
  if (/^\d*\s*status code \(no body\)$/i.test(trimmed)) return "";
  if (typeof status !== "number") return trimmed;
  return trimmed.replace(new RegExp(`^${status}\\s+`), "").trim() || trimmed;
}

function trunc(s: string): string {
  return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}…` : s;
}

function withScalar(key: keyof BodyDetails, value: unknown): BodyDetails {
  const s = scalar(value);
  return s ? { [key]: s } : {};
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readHeader(headers: unknown): string | undefined {
  return readHeaderValue(headers, REQUEST_ID_HEADERS);
}

function readHeaderValue(
  headers: unknown,
  names: readonly string[],
): string | undefined {
  if (!headers) return undefined;
  const get = (headers as { get?: unknown }).get;
  const getter = typeof get === "function" ? get.bind(headers) : undefined;
  for (const name of names) {
    const raw = getter
      ? (getter(name) as string | null)
      : (asRecord(headers)?.[name] ?? asRecord(headers)?.[name.toLowerCase()]);
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return undefined;
}

function readCapturedErrorBody(headers: unknown): string | undefined {
  return headers && typeof headers === "object"
    ? capturedErrorBodies.get(headers)
    : undefined;
}
