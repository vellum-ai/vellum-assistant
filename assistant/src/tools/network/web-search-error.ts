// Single source of truth for classifying `web_search` provider/backend
// failures and the user-facing copy we surface for them (ATL-727).
//
// This is a pure leaf module: it has NO imports from `daemon/`, `agent/`,
// `apps/`, or any client/UI package. It may only import the logger and pino
// types (for the telemetry helper). Every web_search code path — native
// Anthropic handler, app-side providers, and the web client default — funnels
// failures through `classifyWebSearchFailure` so the same friendly message
// propagates to every client via `WebSearchMetadata.errorMessage`.

import type { Logger } from "pino";

import { isAbortReason } from "../../util/abort-reasons.js";
import { truncateForLog } from "../../util/logger.js";
import { isRetryableNetworkError } from "../../util/retry.js";

/**
 * Canonical user-facing copy for a recoverable web_search backend failure.
 * This is what propagates to every client via `WebSearchMetadata.errorMessage`.
 *
 * It names the search tool as the thing struggling, offers retry /
 * continue-without-search / paste-details, does not blame the user, does not
 * imply we can fix the provider, does not claim the whole internet or all
 * tools are down, and contains no raw provider details, JSON, stack traces,
 * or exception names.
 */
export const WEB_SEARCH_BACKEND_FAILURE_MESSAGE =
  "Search is having trouble right now. You can try again in a moment, continue without web search, or paste the relevant details here and I'll use those.";

const QUERY_TOO_LONG_MESSAGE =
  "That search query was too long. Try a shorter query.";

const MAX_USES_EXCEEDED_MESSAGE =
  "I've hit the web-search limit for this turn. I can continue without more searches, or you can paste the details and I'll use those.";

const CONFIG_MESSAGE = "Web search isn't configured.";

export type WebSearchFailureCategory =
  | "backend_unavailable"
  | "rate_limited"
  | "query_too_long"
  | "max_uses_exceeded"
  | "config"
  | "no_results"
  | "unknown";

export interface WebSearchFailureClassification {
  category: WebSearchFailureCategory;
  isBackendFailure: boolean;
  userMessage: string;
  rawDetail: string;
}

export interface WebSearchFailureInput {
  /** Anthropic `web_search_tool_result_error` code, when present. */
  errorCode?: string;
  /** Thrown error or rejected value from a fetch/provider call. */
  error?: unknown;
  /** HTTP status code from a provider response, when present. */
  statusCode?: number;
  /** Whether the tool result was flagged as an error. */
  isError?: boolean;
  /** Whether a successful call returned any results. */
  hasResults?: boolean;
}

/** Categories we consider a transient backend failure worth the friendly copy. */
function isBackendFailureCategory(category: WebSearchFailureCategory): boolean {
  return category === "backend_unavailable" || category === "rate_limited";
}

function userMessageFor(category: WebSearchFailureCategory): string {
  switch (category) {
    case "backend_unavailable":
    case "rate_limited":
      return WEB_SEARCH_BACKEND_FAILURE_MESSAGE;
    case "query_too_long":
      return QUERY_TOO_LONG_MESSAGE;
    case "max_uses_exceeded":
      return MAX_USES_EXCEEDED_MESSAGE;
    case "config":
      return CONFIG_MESSAGE;
    case "no_results":
    case "unknown":
      // Neutral passthrough: callers keep their existing behavior.
      return "";
  }
}

/** Map an Anthropic `web_search_tool_result_error` code to a category. */
function categoryFromErrorCode(
  errorCode: string,
): WebSearchFailureCategory | undefined {
  switch (errorCode) {
    case "unavailable":
    case "internal_error":
    case "overloaded_error":
      return "backend_unavailable";
    case "too_many_requests":
      return "rate_limited";
    case "query_too_long":
      return "query_too_long";
    case "max_uses_exceeded":
      return "max_uses_exceeded";
    case "invalid_input":
      // Recoverable, but not a backend failure — let callers handle it.
      return "unknown";
    default:
      return undefined;
  }
}

/** Map an HTTP status code to a category. */
function categoryFromStatusCode(
  statusCode: number,
): WebSearchFailureCategory | undefined {
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 401 || statusCode === 403) return "config";
  if (statusCode >= 500) return "backend_unavailable";
  return undefined;
}

/**
 * Classify a thrown error / rejected value. This module is web_search-only, so
 * network-layer failures (fetch failed, connection reset/refused, DNS, and
 * timeouts without an explicit user-abort reason) are treated as backend
 * failures.
 */
function categoryFromError(error: unknown): WebSearchFailureCategory | undefined {
  if (error == null) return undefined;

  // A user-initiated abort (Stop/Esc, preemption, dispose) is not a failure.
  // The tagged `AbortReason` may surface directly (`AbortSignal.throwIfAborted`
  // throws `signal.reason` verbatim), via `error.reason`, or — when a provider
  // wrapper erases the `AbortError` name — on `ProviderError.abortReason`. Check
  // all three FIRST, before the transport-retryability and abort/timeout
  // substring heuristics, so a tagged cancellation that ALSO carries a
  // transport-shaped `cause` (e.g. ECONNRESET) short-circuits to "not a
  // failure" instead of being mislabeled a backend outage. A bare
  // AbortError/timeout with no tagged reason still falls through below.
  if (
    isAbortReason(error) ||
    isAbortReason((error as { reason?: unknown }).reason) ||
    isAbortReason((error as { abortReason?: unknown }).abortReason)
  ) {
    return undefined;
  }

  // Retryable transport failures (ECONNRESET/ECONNREFUSED/ETIMEDOUT, socket
  // hang-ups, including one level of `cause` chain) are backend failures.
  if (isRetryableNetworkError(error)) return "backend_unavailable";

  const name = typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "";
  const haystack = `${name} ${(error as { message?: unknown }).message ?? ""}`
    .toLowerCase();

  // web_search-only: treat aborts/timeouts/DNS/fetch failures (the cases
  // `isRetryableNetworkError` doesn't cover) as backend failures.
  if (
    name === "AbortError" ||
    haystack.includes("abort") ||
    haystack.includes("timeout") ||
    haystack.includes("timed out") ||
    haystack.includes("fetch failed") ||
    haystack.includes("failed to fetch") ||
    haystack.includes("enotfound")
  ) {
    return "backend_unavailable";
  }
  return undefined;
}

/** Build the internal-only raw detail string (never embedded in userMessage). */
function buildRawDetail(input: WebSearchFailureInput): string {
  const parts: string[] = [];
  if (input.errorCode) parts.push(`errorCode=${input.errorCode}`);
  if (typeof input.statusCode === "number") {
    parts.push(`statusCode=${input.statusCode}`);
  }
  if (input.error != null) {
    const err = input.error as { message?: unknown };
    const msg =
      typeof err.message === "string" ? err.message : String(input.error);
    if (msg) parts.push(msg);
  }
  return truncateForLog(parts.join(" "), 500);
}

/**
 * Classify a web_search failure into a stable category, a user-facing message,
 * and an internal-only raw detail. Never treats an empty-but-successful result
 * as a failure.
 */
export function classifyWebSearchFailure(
  input: WebSearchFailureInput,
): WebSearchFailureClassification {
  const rawDetail = buildRawDetail(input);

  // Success-passthrough: nothing went wrong, there were just no results.
  if (!input.isError && input.error == null) {
    return {
      category: "no_results",
      isBackendFailure: false,
      userMessage: userMessageFor("no_results"),
      rawDetail,
    };
  }

  // Resolution order: Anthropic `errorCode` → explicit HTTP `statusCode` →
  // error-body/network heuristics. An explicit status code is authoritative
  // over substring-sniffing the provider's response body (which can contain
  // misleading keywords like "timeout"/"abort"). Tagged user-aborts carry no
  // status code, so they still flow through `categoryFromError` and
  // short-circuit to a non-failure.
  const category =
    (input.errorCode != null
      ? categoryFromErrorCode(input.errorCode)
      : undefined) ??
    (typeof input.statusCode === "number"
      ? categoryFromStatusCode(input.statusCode)
      : undefined) ??
    categoryFromError(input.error) ??
    "unknown";

  return {
    category,
    isBackendFailure: isBackendFailureCategory(category),
    userMessage: userMessageFor(category),
    rawDetail,
  };
}

export interface WebSearchBackendFailureMeta {
  provider: string;
  requestId?: string;
  errorCategory: WebSearchFailureCategory;
  rawDetail: string;
  fallbackShown: boolean;
  queryLength?: number;
}

/**
 * Emit a structured warning for a web_search backend failure (ATL-727).
 *
 * Do NOT log raw query text — only `queryLength`. `rawDetail` is internal-only
 * provider/HTTP context and must never be surfaced to users.
 */
export function logWebSearchBackendFailure(
  log: Logger,
  meta: WebSearchBackendFailureMeta,
): void {
  log.warn(
    {
      event: "web_search_backend_failure",
      tool: "web_search",
      provider: meta.provider,
      requestId: meta.requestId,
      errorCategory: meta.errorCategory,
      rawDetail: meta.rawDetail,
      fallbackShown: meta.fallbackShown,
      queryLength: meta.queryLength,
    },
    "web_search backend failure",
  );
}
