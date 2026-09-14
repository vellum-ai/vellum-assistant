/**
 * Outbound-request Unicode guard for every provider adapter.
 *
 * JavaScript strings are UTF-16, and any `.slice()` on a code-unit boundary
 * can orphan half of a surrogate pair. `JSON.stringify` emits the orphan as a
 * `\udXXX` escape, which strict API parsers reject with a 400 before the model
 * runs (Anthropic: "no low surrogate in string"; OpenAI: `invalid_json`).
 * `RetryProvider` sanitizes the caller's messages and options once at entry,
 * so every attempt, corrective resend, credential refresh, and backup route
 * sends a clean payload, and sanitizes token-count requests the same way.
 * Nothing beneath the wrapper truncates text, so this is the one place the
 * invariant is enforced.
 *
 * The replacement is lossy (U+FFFD), so the warning names the block types
 * involved: the durable fix for any offender is a surrogate-safe slice at the
 * truncation site (`safeStringSlice` in `util/unicode.ts`).
 */

import { getLogger } from "../util/logger.js";
import { stripOrphanedSurrogatesDeep } from "../util/unicode.js";
import type { Message, SendMessageOptions } from "./types.js";

const log = getLogger("outbound-request-sanitize");

/** Rate-limit the warning so a poisoned conversation cannot flood the log. */
const ORPHAN_WARNING_THROTTLE_MS = 60_000;
let lastOrphanWarningMs = 0;

export interface OutboundRequest {
  messages: Message[];
  options: SendMessageOptions | undefined;
}

/**
 * Fields that hold provider-bound base64 (an inline media source's payload,
 * a redacted-thinking blob) are ASCII by construction and can run to over a
 * hundred megabytes, so scanning them is pure event-loop cost.
 */
function isBase64Payload(
  key: string,
  parent: Record<string, unknown>,
): boolean {
  return (
    key === "data" &&
    (parent.type === "base64" || parent.type === "redacted_thinking")
  );
}

/**
 * Replace every orphaned UTF-16 surrogate in the request's messages and
 * options with U+FFFD. Returns the same references when nothing needed
 * fixing, so the happy path allocates nothing.
 */
export function sanitizeOutboundRequest(
  providerName: string,
  request: OutboundRequest,
): OutboundRequest {
  const sanitized = stripOrphanedSurrogatesDeep(request, {
    skipKey: isBase64Payload,
  });
  if (!sanitized.changed) {
    return request;
  }
  logOrphanedSurrogateWarning(
    providerName,
    sanitized.fixedStringCount,
    request.messages,
  );
  return sanitized.value;
}

function logOrphanedSurrogateWarning(
  providerName: string,
  fixedStringCount: number,
  messages: Message[],
): void {
  const now = Date.now();
  if (now - lastOrphanWarningMs < ORPHAN_WARNING_THROTTLE_MS) {
    return;
  }
  lastOrphanWarningMs = now;
  const blockTypes = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      blockTypes.add(block.type);
    }
  }
  log.warn(
    {
      provider: providerName,
      fixedStringCount,
      blockTypes: Array.from(blockTypes),
    },
    "stripped orphaned UTF-16 surrogates from an outbound LLM request; an upstream truncation is not surrogate-aware",
  );
}
