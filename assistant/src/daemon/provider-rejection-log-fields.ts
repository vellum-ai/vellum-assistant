/**
 * Log-field builder for provider rejections that carry no actionable
 * classification of their own (unclassified 4xx).
 *
 * The extracted fields on `ProviderError` (`apiErrorCode`, `message`) drop the
 * detail an operator needs to find the offending request: which request field,
 * which message, which byte pattern. The verbatim upstream body carries it, so
 * it rides the log record, bounded so a large provider error page cannot flood
 * the log stream.
 */

import { ProviderError } from "../util/errors.js";
import { redactLogString } from "../util/log-redact.js";

/**
 * Ceiling for the logged upstream body. Bodies are already capped at 16 KiB
 * when captured (`providers/openai/api-error-normalization.ts`); this second,
 * tighter bound is what a log record carries.
 */
export const MAX_LOGGED_UPSTREAM_BODY_CHARS = 4096;

/**
 * Upstream error codes whose message names the offending request content part,
 * e.g. `Invalid 'input[191].content[1].text': string too long`. Kept narrow:
 * codes outside this set have no such pointer, so parsing their message would
 * only produce coincidental matches.
 */
const CONTENT_PART_POINTER_CODES = new Set([
  "string_above_max_length",
  "invalid_body",
]);

/**
 * Positional pointer into the request payload. `input[N]` is the Responses API
 * shape, `messages[N]` the Chat Completions shape; both index the request's
 * message array in send order, so `N` is an offset into the conversation
 * history that produced the request.
 */
const CONTENT_PART_POINTER = /\b(?:input|messages)\[(\d+)\]\.content\[(\d+)\]/i;

export interface ProviderRejectionLogFields {
  /** Verbatim upstream non-2xx body, truncated to the logged ceiling. */
  upstreamErrorBody: string | null;
  /** True when the body was cut to fit the ceiling. */
  upstreamErrorBodyTruncated?: boolean;
  apiErrorCode?: string;
  apiErrorType?: string;
  apiErrorParam?: string;
  requestId?: string;
  /** Index of the offending message within the request's message array. */
  offendingMessageIndex?: number;
  /** Index of the offending content part within that message. */
  offendingContentIndex?: number;
}

/**
 * Extract the offending `input[N].content[M]` coordinates from an upstream
 * error message, for the codes that carry such a pointer.
 */
function parseContentPartPointer(
  error: ProviderError,
): Pick<
  ProviderRejectionLogFields,
  "offendingMessageIndex" | "offendingContentIndex"
> {
  const code = error.apiErrorCode?.toLowerCase();
  if (!code || !CONTENT_PART_POINTER_CODES.has(code)) {
    return {};
  }
  const match = CONTENT_PART_POINTER.exec(
    `${error.message} ${error.rawBody ?? ""}`,
  );
  if (!match) {
    return {};
  }
  const messageIndex = Number(match[1]);
  const contentIndex = Number(match[2]);
  if (
    !Number.isSafeInteger(messageIndex) ||
    !Number.isSafeInteger(contentIndex)
  ) {
    return {};
  }
  return {
    offendingMessageIndex: messageIndex,
    offendingContentIndex: contentIndex,
  };
}

/** Diagnostic fields describing what the provider actually rejected. */
export function buildProviderRejectionLogFields(
  error: Error,
): ProviderRejectionLogFields {
  if (!(error instanceof ProviderError)) {
    return { upstreamErrorBody: null };
  }

  // The body is arbitrary upstream text under a custom field name, so it is
  // outside the reach of the pino `err`/`req`/`res` serializers and is scrubbed
  // here before it reaches the record.
  const rawBody =
    error.rawBody === undefined ? undefined : redactLogString(error.rawBody);
  const truncated =
    rawBody !== undefined && rawBody.length > MAX_LOGGED_UPSTREAM_BODY_CHARS;

  return {
    upstreamErrorBody:
      rawBody === undefined
        ? null
        : rawBody.slice(0, MAX_LOGGED_UPSTREAM_BODY_CHARS),
    ...(truncated ? { upstreamErrorBodyTruncated: true } : {}),
    ...(error.apiErrorCode !== undefined
      ? { apiErrorCode: error.apiErrorCode }
      : {}),
    ...(error.apiErrorType !== undefined
      ? { apiErrorType: error.apiErrorType }
      : {}),
    ...(error.apiErrorParam !== undefined
      ? { apiErrorParam: error.apiErrorParam }
      : {}),
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    ...parseContentPartPointer(error),
  };
}
