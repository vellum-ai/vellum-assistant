import { isContextOverflowError } from "../providers/types.js";

/**
 * Parse the actual token count reported by the provider for a
 * context-too-large failure.
 *
 * Prefers the typed `ContextOverflowError.actualTokens` field when the
 * thrown error is one. Falls back to regex-parsing the message for patterns
 * like:
 *   "prompt is too long: 242201 tokens > 200000 maximum"   (Anthropic)
 *   "too many input tokens: 242201 > 200000"                (OpenAI)
 *
 * The regex path remains a safety net for provider-adapter paths (e.g.
 * managed-proxy rewrappers) that surface untyped errors.
 *
 * Accepts a raw error object, an `Error` instance, or a plain string.
 * Returns the actual token count, or `null` when it cannot be determined.
 */
export function parseActualTokensFromError(
  errorOrMessage: unknown,
): number | null {
  // Typed path — the provider client wrapped a matching upstream error as
  // ContextOverflowError. Use the parsed field directly when available.
  if (isContextOverflowError(errorOrMessage)) {
    const actual = errorOrMessage.actualTokens;
    if (typeof actual === "number" && actual > 0) return actual;
    // Typed error without `actualTokens` — fall through to regex-parse the
    // underlying message in case the upstream body carries it in text form.
    return parseFromMessage(errorOrMessage.message ?? null);
  }

  // Untyped path — accept either an Error or a string.
  if (errorOrMessage == null) return null;
  if (typeof errorOrMessage === "string") {
    return parseFromMessage(errorOrMessage);
  }
  if (typeof errorOrMessage === "object" && "message" in errorOrMessage) {
    const msg = (errorOrMessage as { message?: unknown }).message;
    if (typeof msg === "string") return parseFromMessage(msg);
  }
  return null;
}

function parseFromMessage(errorMessage: string | null): number | null {
  if (!errorMessage) return null;

  // Match patterns like "242201 tokens > 200000" or "242201 > 200000 maximum"
  const match = errorMessage.match(
    /(\d[\d,]*)\s*tokens?\s*[>≥]|:\s*(\d[\d,]*)\s*[>≥]/i,
  );
  if (match) {
    const raw = (match[1] || match[2]).replace(/,/g, "");
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  // Fallback: match "too many input tokens: N > M"
  const fallback = errorMessage.match(/(\d[\d,]*)\s*[>≥]\s*\d/);
  if (fallback) {
    const raw = fallback[1].replace(/,/g, "");
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return null;
}
