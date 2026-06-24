import type OpenAI from "openai";

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
// the thrown APIError. captureRawErrorBodyFetch re-attaches the raw body under
// this header so it rides onto `APIError.headers`, correlated to its own
// request — no shared provider state for concurrent calls to clobber.
const CAPTURED_BODY_HEADER = "x-vellum-captured-error-body";
// Bound the header so a huge HTML error page can't balloon it; the message is
// re-truncated to MAX_DETAIL_CHARS downstream anyway.
const MAX_CAPTURED_BODY_CHARS = 16_384;

/**
 * SDK `fetch` option that captures non-2xx response bodies. Install via the
 * OpenAI client `fetch` option; safe to share across requests and instances
 * because the captured body travels on the response (and thus the thrown
 * error), not on any shared field.
 */
export const captureRawErrorBodyFetch = async (
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const res = await globalThis.fetch(url, init);
  if (res.ok) return res;
  // clone() so the empty-body passthrough below leaves the SDK's own read intact.
  const body = await res
    .clone()
    .text()
    .catch(() => undefined);
  // Empty body: nothing to capture, and reconstructing a no-body status (304)
  // with a body would throw. Hand the original response back untouched.
  if (!body) return res;
  const headers = new Headers(res.headers);
  headers.set(CAPTURED_BODY_HEADER, encodeCapturedBody(body));
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
};

export function normalizeOpenAIAPIError(
  error: InstanceType<typeof OpenAI.APIError>,
  rawBody: string | undefined = readCapturedErrorBody(error.headers),
): NormalizedOpenAIAPIError {
  // Prefer the captured raw body (intact upstream payload) over the SDK's
  // already-parsed `error.error`, which may have collapsed the detail.
  const parsed = parseBody(rawBody) ?? (error as { error?: unknown }).error;
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

function encodeCapturedBody(body: string): string {
  const capped =
    body.length > MAX_CAPTURED_BODY_CHARS
      ? body.slice(0, MAX_CAPTURED_BODY_CHARS)
      : body;
  return Buffer.from(capped, "utf8").toString("base64");
}

function readCapturedErrorBody(headers: unknown): string | undefined {
  const encoded = readHeaderValue(headers, [CAPTURED_BODY_HEADER]);
  if (!encoded) return undefined;
  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}
