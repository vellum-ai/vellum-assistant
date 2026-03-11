import { ProviderError } from "../util/errors.js";
import type {
  SessionErrorCode,
  SessionErrorMessage,
} from "./message-protocol.js";

/**
 * Classified session error ready for client emission.
 */
export interface ClassifiedSessionError {
  code: SessionErrorCode;
  userMessage: string;
  retryable: boolean;
  debugDetails?: string;
}

// Network-level error patterns (connection refused, timeout, DNS, reset)
const NETWORK_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket hang up/i,
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

// User-initiated cancellation patterns — these should NOT produce session_error
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
 * instead of `session_error`.
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
 * Classify an unknown error into a structured session error.
 * Does NOT handle user-initiated cancellation — callers should check
 * `isUserCancellation` first and emit `generation_cancelled` instead.
 *
 * Classification priority:
 * 1. Phase-specific overrides (queue, regenerate)
 * 2. ProviderError.statusCode (deterministic for provider failures)
 * 3. Regex fallback for network/cancel/unknown errors
 */
export function classifySessionError(
  error: unknown,
  ctx: ErrorContext,
): ClassifiedSessionError {
  const message = error instanceof Error ? error.message : String(error);
  const rawDetails =
    (error instanceof Error ? error.stack : undefined) ?? message;
  const debugDetails = truncateDebugDetails(rawDetails);

  // Phase-specific overrides
  if (ctx.phase === "regenerate") {
    const base = classifyCore(error, message);
    return {
      code: "REGENERATE_FAILED",
      userMessage: `Could not regenerate the response. ${base.userMessage}`,
      retryable: true,
      debugDetails,
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
): Omit<ClassifiedSessionError, "debugDetails"> {
  // ProviderError with statusCode — deterministic classification
  if (error instanceof ProviderError && error.statusCode !== undefined) {
    if (error.statusCode === 413) {
      return {
        code: "CONTEXT_TOO_LARGE",
        userMessage: "This conversation exceeds the model's context limit.",
        retryable: false,
      };
    }
    if (error.statusCode === 429) {
      return {
        code: "PROVIDER_RATE_LIMIT",
        userMessage: "The AI provider is rate limiting requests.",
        retryable: true,
      };
    }
    if (error.statusCode >= 500) {
      return {
        code: "PROVIDER_API",
        userMessage: "The AI provider returned a server error.",
        retryable: true,
      };
    }
    // 4xx (non-429) — check for context-too-large before generic fallback
    if (error.statusCode >= 400) {
      if (isContextTooLarge(message)) {
        return {
          code: "CONTEXT_TOO_LARGE",
          userMessage: "This conversation exceeds the model's context limit.",
          retryable: false,
        };
      }
      if (/credit balance is too low|insufficient.*credits?/i.test(message)) {
        return {
          code: "PROVIDER_BILLING",
          userMessage: "Your API key has insufficient credits.",
          retryable: false,
        };
      }
      if (
        /invalid.*api.?key|invalid.*x-api-key|authentication.?error|invalid.authentication/i.test(
          message,
        )
      ) {
        return {
          code: "PROVIDER_BILLING",
          userMessage: "Your API key is invalid.",
          retryable: false,
        };
      }
      return {
        code: "PROVIDER_API",
        userMessage: "The AI provider rejected the request.",
        retryable: true,
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

function classifyByMessage(
  message: string,
): Omit<ClassifiedSessionError, "debugDetails"> {
  // Check context-too-large before other patterns
  if (isContextTooLarge(message)) {
    return {
      code: "CONTEXT_TOO_LARGE",
      userMessage: "This conversation exceeds the model's context limit.",
      retryable: false,
    };
  }

  // Check rate limit first (before network, since 429 could match both)
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: "PROVIDER_RATE_LIMIT",
        userMessage: "The AI provider is rate limiting requests.",
        retryable: true,
      };
    }
  }

  // Network errors (before timeout so "connection timeout" is classified as network)
  for (const pattern of NETWORK_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: "PROVIDER_NETWORK",
        userMessage: "Could not connect to the AI provider.",
        retryable: true,
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
      };
    }
  }

  // Non-user abort/failure (e.g. AbortError from internal logic, not user cancel)
  for (const pattern of CANCEL_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: "SESSION_ABORTED",
        userMessage: "The request was interrupted.",
        retryable: true,
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
    code: "SESSION_PROCESSING_FAILED",
    userMessage,
    retryable: false,
  };
}

/**
 * Build a `session_error` server message from a classified error.
 */
export function buildSessionErrorMessage(
  sessionId: string,
  classified: ClassifiedSessionError,
): SessionErrorMessage {
  return {
    type: "session_error",
    sessionId,
    code: classified.code,
    userMessage: classified.userMessage,
    retryable: classified.retryable,
    debugDetails: classified.debugDetails,
  };
}
