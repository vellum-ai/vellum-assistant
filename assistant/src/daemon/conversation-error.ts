import { getProviderRoutingSource } from "../providers/registry.js";
import { ProviderError, ProviderNotConfiguredError } from "../util/errors.js";
import type {
  ConversationErrorCode,
  ConversationErrorMessage,
} from "./message-protocol.js";

/**
 * Classified conversation error ready for client emission.
 */
export interface ClassifiedConversationError {
  code: ConversationErrorCode;
  userMessage: string;
  retryable: boolean;
  debugDetails?: string;
  /** Machine-readable error category for log report metadata and triage. */
  errorCategory: string;
}

// Network-level error patterns (connection refused, timeout, DNS, reset)
const NETWORK_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /socket.*closed unexpectedly/i,
  /network.*error/i,
  /fetch failed/i,
  /connection.*refused/i,
  /connection.*reset/i,
  /connection.*timeout/i,
];

// Rate limit patterns (HTTP 429 or explicit rate limit messages)
const RATE_LIMIT_PATTERNS = [
  /429/,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
];

// Context-too-large patterns (request exceeds the model's context window)
const CONTEXT_TOO_LARGE_PATTERNS = [
  /context.?length.?exceeded/i,
  /maximum.?context.?length/i,
  /token.?limit.?exceeded/i,
  /prompt.?is.?too.?long/i,
  /conversation.*too long.*model.*process/i,
  /too long for the model to process/i,
  /request too large/i,
  /too many.*input.*tokens/i,
  /max_tokens.*exceeded/i,
  /exceeded.*max_tokens/i,
];

// Generic timeout patterns — checked after NETWORK_PATTERNS and PROVIDER_API_PATTERNS
// so that "connection timeout" → PROVIDER_NETWORK and "gateway timeout" → PROVIDER_API
const TIMEOUT_PATTERNS = [
  /\btimeout\b/i,
  /deadline.?exceeded/i,
  /request.?timed?.?out/i,
];

// Provider API error patterns (5xx, server error, etc.)
const PROVIDER_API_PATTERNS = [
  /\b5\d{2}\b/,
  /server error/i,
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
];

// Provider ordering error patterns (tool_use/tool_result mismatches)
const ORDERING_ERROR_PATTERNS = [
  /tool_result.*not immediately after.*tool_use/i,
  /tool_use.*must have.*tool_result/i,
  /tool_use_id.*without.*tool_result/i,
  /tool_result.*tool_use_id.*not found/i,
  /messages.*invalid.*order/i,
];

// Web-search-specific ordering error patterns
const WEB_SEARCH_ORDERING_PATTERNS = [
  /web_search.*tool_use.*without/i,
  /web_search.*tool_result/i,
];

// Streaming corruption patterns (Anthropic SDK throws non-HTTP errors for SSE issues)
const STREAMING_ERROR_PATTERNS = [
  /unexpected event order/i,
  /stream ended without producing/i,
  /request ended without sending any chunks/i,
  /stream has ended.*this shouldn't happen/i,
];

// User-initiated cancellation patterns — these should NOT produce conversation_error
const CANCEL_PATTERNS = [/abort/i, /cancel/i];

/**
 * Context about where the error occurred, used to refine classification.
 */
export interface ErrorContext {
  /** Where in the processing pipeline the error occurred. */
  phase: "agent_loop" | "regenerate" | "handler" | "persist";
  /** Whether the abort signal was active when the error occurred. */
  aborted?: boolean;
}

/**
 * Returns true if the error looks like a user-initiated cancellation
 * (AbortError or explicit cancel). These should use `generation_cancelled`
 * instead of `conversation_error`.
 */
export function isUserCancellation(error: unknown, ctx: ErrorContext): boolean {
  if (!ctx.aborted) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

/** Maximum length for debugDetails to prevent unbounded event payloads. */
const MAX_DEBUG_DETAIL_LENGTH = 4000;

/**
 * Truncate debug details to a reasonable size for transport.
 */
function truncateDebugDetails(details: string): string {
  if (details.length <= MAX_DEBUG_DETAIL_LENGTH) return details;
  return details.slice(0, MAX_DEBUG_DETAIL_LENGTH) + "\n… (truncated)";
}

/**
 * Classify an unknown error into a structured conversation error.
 * Does NOT handle user-initiated cancellation — callers should check
 * `isUserCancellation` first and emit `generation_cancelled` instead.
 *
 * Classification priority:
 * 1. Phase-specific overrides (queue, regenerate)
 * 2. ProviderError.statusCode (deterministic for provider failures)
 * 3. Regex fallback for network/cancel/unknown errors
 */
export function classifyConversationError(
  error: unknown,
  ctx: ErrorContext,
): ClassifiedConversationError {
  const message = error instanceof Error ? error.message : String(error);
  const rawDetails =
    (error instanceof Error ? error.stack : undefined) ?? message;
  const debugDetails = truncateDebugDetails(rawDetails);

  // Dedicated classification for missing provider API key
  if (error instanceof ProviderNotConfiguredError) {
    return {
      code: "PROVIDER_NOT_CONFIGURED",
      userMessage:
        "No API key configured for inference. Add one in Settings to start chatting.",
      retryable: true,
      errorCategory: "provider_not_configured",
      debugDetails,
    };
  }

  // Phase-specific overrides
  if (ctx.phase === "regenerate") {
    const base = classifyCore(error, message);
    return {
      code: "REGENERATE_FAILED",
      userMessage: `Could not regenerate the response. ${base.userMessage}`,
      retryable: true,
      debugDetails,
      errorCategory: `regenerate:${base.errorCategory}`,
    };
  }

  // Classify using statusCode (if ProviderError) then regex fallback
  const classified = classifyCore(error, message);
  return {
    ...classified,
    debugDetails,
  };
}

/**
 * Core classification: check ProviderError.statusCode first for
 * deterministic classification, then fall back to regex patterns.
 */
function classifyCore(
  error: unknown,
  message: string,
): Omit<ClassifiedConversationError, "debugDetails"> {
  // ProviderError with statusCode — deterministic classification
  if (error instanceof ProviderError && error.statusCode !== undefined) {
    if (error.statusCode === 413) {
      return {
        code: "CONTEXT_TOO_LARGE",
        userMessage:
          "This conversation is too long. Please start a new conversation.",
        retryable: false,
        errorCategory: "context_too_large",
      };
    }
    if (error.statusCode === 401 || error.statusCode === 403) {
      if (
        /invalid.*api.?key|invalid.*x-api-key|authentication.?error/i.test(
          message,
        )
      ) {
        // Check if this provider is routed through the managed proxy.
        // If so, the assistant API key is stale — the client should reprovision.
        const providerName = error.provider;
        if (getProviderRoutingSource(providerName) === "managed-proxy") {
          return {
            code: "MANAGED_KEY_INVALID",
            userMessage:
              "The assistant API key is invalid. Attempting to re-provision…",
            retryable: true,
            errorCategory: "managed_key_invalid",
          };
        }
        return {
          code: "PROVIDER_NOT_CONFIGURED",
          userMessage:
            "Your API key is invalid or expired. Update it in Settings or switch to managed mode.",
          retryable: false,
          errorCategory: "provider_not_configured",
        };
      }
    }
    if (error.statusCode === 401) {
      return {
        code: "PROVIDER_NOT_CONFIGURED",
        userMessage:
          "Your API key is invalid or expired. Update it in Settings or switch to managed mode.",
        retryable: false,
        errorCategory: "provider_not_configured",
      };
    }
    if (error.statusCode === 402) {
      return {
        code: "PROVIDER_BILLING",
        userMessage:
          "You've run out of credits. Add funds to continue using the assistant.",
        retryable: false,
        errorCategory: "credits_exhausted",
      };
    }
    if (error.statusCode === 429) {
      return {
        code: "PROVIDER_RATE_LIMIT",
        userMessage: "The AI provider is busy. Please try again in a moment.",
        retryable: true,
        errorCategory: "rate_limit",
      };
    }
    if (error.statusCode >= 500) {
      return {
        code: "PROVIDER_API",
        userMessage: "The AI provider returned a server error.",
        retryable: true,
        errorCategory: "provider_server_error",
      };
    }
    // 4xx (non-429) — check for context-too-large, ordering errors, then generic fallback
    if (error.statusCode >= 400) {
      if (isContextTooLarge(message)) {
        return {
          code: "CONTEXT_TOO_LARGE",
          userMessage:
            "This conversation is too long. Please start a new conversation.",
          retryable: false,
          errorCategory: "context_too_large",
        };
      }
      if (isWebSearchOrderingError(message)) {
        return {
          code: "PROVIDER_WEB_SEARCH",
          userMessage:
            "An internal error occurred with web search. Please try again.",
          retryable: true,
          errorCategory: "web_search_ordering",
        };
      }
      if (isOrderingError(message)) {
        return {
          code: "PROVIDER_ORDERING",
          userMessage: "An internal error occurred. Please try again.",
          retryable: true,
          errorCategory: "tool_ordering",
        };
      }
      if (/credit balance is too low|insufficient.*credits?/i.test(message)) {
        return {
          code: "PROVIDER_BILLING",
          userMessage: "Your API key has insufficient credits.",
          retryable: false,
          errorCategory: "provider_billing",
        };
      }
      if (
        /invalid.*api.?key|invalid.*x-api-key|authentication.?error|invalid.authentication/i.test(
          message,
        )
      ) {
        return {
          code: "PROVIDER_NOT_CONFIGURED",
          userMessage:
            "Your API key is invalid. Update it in Settings or switch to managed mode.",
          retryable: false,
          errorCategory: "provider_not_configured",
        };
      }
      return {
        code: "PROVIDER_API",
        userMessage: "The AI provider rejected the request.",
        retryable: true,
        errorCategory: "provider_api_error",
      };
    }
  }

  // Regex fallback for non-ProviderError or ProviderError without statusCode
  return classifyByMessage(message);
}

/** Check whether an error message indicates a context-too-large failure. */
export function isContextTooLarge(message: string): boolean {
  return CONTEXT_TOO_LARGE_PATTERNS.some((p) => p.test(message));
}

/** Check whether an error message indicates a web-search-specific ordering failure. */
export function isWebSearchOrderingError(message: string): boolean {
  return WEB_SEARCH_ORDERING_PATTERNS.some((p) => p.test(message));
}

/** Check whether an error message indicates a tool_use/tool_result ordering failure. */
export function isOrderingError(message: string): boolean {
  return ORDERING_ERROR_PATTERNS.some((p) => p.test(message));
}

/** Check whether an error message indicates an Anthropic SDK streaming corruption. */
export function isStreamingError(message: string): boolean {
  return STREAMING_ERROR_PATTERNS.some((p) => p.test(message));
}

function classifyByMessage(
  message: string,
): Omit<ClassifiedConversationError, "debugDetails"> {
  // Check context-too-large before other patterns
  if (isContextTooLarge(message)) {
    return {
      code: "CONTEXT_TOO_LARGE",
      userMessage:
        "This conversation is too long. Please start a new conversation.",
      retryable: false,
      errorCategory: "context_too_large",
    };
  }

  // Check rate limit first (before network, since 429 could match both)
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: "PROVIDER_RATE_LIMIT",
        userMessage: "The AI provider is busy. Please try again in a moment.",
        retryable: true,
        errorCategory: "rate_limit",
      };
    }
  }

  // Web-search ordering errors (before general ordering errors)
  if (isWebSearchOrderingError(message)) {
    return {
      code: "PROVIDER_WEB_SEARCH",
      userMessage:
        "An internal error occurred with web search. Please try again.",
      retryable: true,
      errorCategory: "web_search_ordering",
    };
  }

  // General tool_use/tool_result ordering errors
  if (isOrderingError(message)) {
    return {
      code: "PROVIDER_ORDERING",
      userMessage: "An internal error occurred. Please try again.",
      retryable: true,
      errorCategory: "tool_ordering",
    };
  }

  // Network errors (before timeout so "connection timeout" is classified as network)
  for (const pattern of NETWORK_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: "PROVIDER_NETWORK",
        userMessage: "Could not connect to the AI provider.",
        retryable: true,
        errorCategory: "provider_network",
      };
    }
  }

  // Provider API errors (before timeout so "gateway timeout" keeps its specific message)
  for (const pattern of PROVIDER_API_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: "PROVIDER_API",
        userMessage: "The AI provider returned a server error.",
        retryable: true,
        errorCategory: "provider_server_error",
      };
    }
  }

  // Generic timeout errors (checked after network and provider API patterns so
  // specific timeouts like "connection timeout" and "gateway timeout" aren't misclassified)
  for (const pattern of TIMEOUT_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: "PROVIDER_API",
        userMessage: "The request to the AI provider timed out.",
        retryable: true,
        errorCategory: "provider_timeout",
      };
    }
  }

  // Streaming corruption errors (Anthropic SDK SSE issues — transient, retryable)
  if (isStreamingError(message)) {
    return {
      code: "PROVIDER_API",
      userMessage:
        "The AI provider's response was interrupted. Please try again.",
      retryable: true,
      errorCategory: "stream_corruption",
    };
  }

  // Non-user abort/failure (e.g. AbortError from internal logic, not user cancel)
  for (const pattern of CANCEL_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: "CONVERSATION_ABORTED",
        userMessage: "The request was interrupted.",
        retryable: true,
        errorCategory: "session_aborted",
      };
    }
  }

  // Default: processing failure — include the first non-empty line of the actual error
  // so users know what went wrong instead of seeing a completely generic message.
  const firstLine =
    message
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const summary =
    firstLine.length > 150 ? firstLine.slice(0, 150) + "..." : firstLine;
  const userMessage = summary
    ? `Processing failed: ${summary}`
    : "Something went wrong processing your message. Please try again.";
  return {
    code: "CONVERSATION_PROCESSING_FAILED",
    userMessage,
    retryable: false,
    errorCategory: "processing_failed",
  };
}

/**
 * Build a `conversation_error` server message from a classified error.
 */
export function buildConversationErrorMessage(
  conversationId: string,
  classified: ClassifiedConversationError,
): ConversationErrorMessage {
  return {
    type: "conversation_error",
    conversationId,
    code: classified.code,
    userMessage: classified.userMessage,
    retryable: classified.retryable,
    debugDetails: classified.debugDetails,
    errorCategory: classified.errorCategory,
  };
}
