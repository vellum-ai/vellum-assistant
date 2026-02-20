import type { SessionErrorCode, SessionErrorMessage } from './ipc-protocol.js';
import { ProviderError } from '../util/errors.js';

/**
 * Classified session error ready for IPC emission.
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
const CANCEL_PATTERNS = [
  /abort/i,
  /cancel/i,
];

/**
 * Context about where the error occurred, used to refine classification.
 */
export interface ErrorContext {
  /** Where in the processing pipeline the error occurred. */
  phase: 'agent_loop' | 'queue' | 'regenerate' | 'handler' | 'persist';
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
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return false;
}

/** Maximum length for debugDetails to prevent unbounded IPC payloads. */
const MAX_DEBUG_DETAIL_LENGTH = 4000;

/**
 * Truncate debug details to a reasonable size for IPC transport.
 */
function truncateDebugDetails(details: string): string {
  if (details.length <= MAX_DEBUG_DETAIL_LENGTH) return details;
  return details.slice(0, MAX_DEBUG_DETAIL_LENGTH) + '\n… (truncated)';
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
  const rawDetails = (error instanceof Error ? error.stack : undefined) ?? message;
  const debugDetails = truncateDebugDetails(rawDetails);

  // Phase-specific overrides
  if (ctx.phase === 'queue') {
    return {
      code: 'QUEUE_FULL',
      userMessage: 'Message queue is full (max depth: 10). Please wait for current messages to be processed.',
      retryable: true,
      debugDetails: truncateDebugDetails(message),
    };
  }

  if (ctx.phase === 'regenerate') {
    const base = classifyCore(error, message);
    return {
      code: 'REGENERATE_FAILED',
      userMessage: `Failed to regenerate response. ${base.userMessage}`,
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
): Omit<ClassifiedSessionError, 'debugDetails'> {
  // ProviderError with statusCode — deterministic classification
  if (error instanceof ProviderError && error.statusCode !== undefined) {
    if (error.statusCode === 429) {
      return {
        code: 'PROVIDER_RATE_LIMIT',
        userMessage: 'The AI provider is rate limiting requests. Please wait a moment and try again.',
        retryable: true,
      };
    }
    if (error.statusCode >= 500) {
      return {
        code: 'PROVIDER_API',
        userMessage: 'The AI provider returned an error. This is usually temporary — try again shortly.',
        retryable: true,
      };
    }
    // 4xx (non-429) — check for context-too-large before generic fallback
    if (error.statusCode >= 400) {
      if (isContextTooLarge(message)) {
        return {
          code: 'CONTEXT_TOO_LARGE',
          userMessage: 'The conversation is too long for the model to process. Start a new conversation or try a shorter message.',
          retryable: false,
        };
      }
      return {
        code: 'PROVIDER_API',
        userMessage: 'The AI provider rejected the request. Please try again or check your settings.',
        retryable: false,
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

function classifyByMessage(message: string): Omit<ClassifiedSessionError, 'debugDetails'> {
  // Check context-too-large before other patterns
  if (isContextTooLarge(message)) {
    return {
      code: 'CONTEXT_TOO_LARGE',
      userMessage: 'The conversation is too long for the model to process. Start a new conversation or try a shorter message.',
      retryable: false,
    };
  }

  // Check rate limit first (before network, since 429 could match both)
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: 'PROVIDER_RATE_LIMIT',
        userMessage: 'The AI provider is rate limiting requests. Please wait a moment and try again.',
        retryable: true,
      };
    }
  }

  // Network errors (before timeout so "connection timeout" is classified as network)
  for (const pattern of NETWORK_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: 'PROVIDER_NETWORK',
        userMessage: 'Unable to reach the AI provider. Check your connection and try again.',
        retryable: true,
      };
    }
  }

  // Provider API errors (before timeout so "gateway timeout" keeps its specific message)
  for (const pattern of PROVIDER_API_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: 'PROVIDER_API',
        userMessage: 'The AI provider returned an error. This is usually temporary — try again shortly.',
        retryable: true,
      };
    }
  }

  // Generic timeout errors (checked after network and provider API patterns so
  // specific timeouts like "connection timeout" and "gateway timeout" aren't misclassified)
  for (const pattern of TIMEOUT_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: 'PROVIDER_API',
        userMessage: 'The request took too long. This is usually temporary — try again shortly.',
        retryable: true,
      };
    }
  }

  // Non-user abort/failure (e.g. AbortError from internal logic, not user cancel)
  for (const pattern of CANCEL_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: 'SESSION_ABORTED',
        userMessage: 'The request was interrupted. You can try sending your message again.',
        retryable: true,
      };
    }
  }

  // Default: processing failure
  return {
    code: 'SESSION_PROCESSING_FAILED',
    userMessage: 'Something went wrong processing your message. Please try again.',
    retryable: false,
  };
}

/**
 * Build a `session_error` IPC message from a classified error.
 */
export function buildSessionErrorMessage(
  sessionId: string,
  classified: ClassifiedSessionError,
): SessionErrorMessage {
  return {
    type: 'session_error',
    sessionId,
    code: classified.code,
    userMessage: classified.userMessage,
    retryable: classified.retryable,
    debugDetails: classified.debugDetails,
  };
}
