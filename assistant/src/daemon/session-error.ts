import type { SessionErrorCode, SessionErrorMessage } from './ipc-protocol.js';

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
  if (ctx.aborted) return true;
  if (error instanceof DOMException && error.name === 'AbortError' && ctx.aborted) return true;
  if (error instanceof Error && error.name === 'AbortError' && ctx.aborted) return true;
  return false;
}

/**
 * Classify an unknown error into a structured session error.
 * Does NOT handle user-initiated cancellation — callers should check
 * `isUserCancellation` first and emit `generation_cancelled` instead.
 */
export function classifySessionError(
  error: unknown,
  ctx: ErrorContext,
): ClassifiedSessionError {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  // Phase-specific overrides
  if (ctx.phase === 'queue') {
    return {
      code: 'QUEUE_FULL',
      userMessage: 'The message queue is full. Please wait and try again.',
      retryable: true,
      debugDetails: message,
    };
  }

  if (ctx.phase === 'regenerate') {
    const base = classifyByMessage(message);
    return {
      code: 'REGENERATE_FAILED',
      userMessage: `Failed to regenerate response. ${base.userMessage}`,
      retryable: true,
      debugDetails: stack ?? message,
    };
  }

  // Classify by error message content
  const classified = classifyByMessage(message);
  return {
    ...classified,
    debugDetails: stack ?? message,
  };
}

function classifyByMessage(message: string): Omit<ClassifiedSessionError, 'debugDetails'> {
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

  // Network errors
  for (const pattern of NETWORK_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: 'PROVIDER_NETWORK',
        userMessage: 'Unable to reach the AI provider. Check your connection and try again.',
        retryable: true,
      };
    }
  }

  // Provider API errors (5xx)
  for (const pattern of PROVIDER_API_PATTERNS) {
    if (pattern.test(message)) {
      return {
        code: 'PROVIDER_API',
        userMessage: 'The AI provider returned an error. This is usually temporary — try again shortly.',
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
