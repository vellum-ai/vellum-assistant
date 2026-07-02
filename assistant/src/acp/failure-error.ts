/**
 * Derives a human-meaningful failure message for a failed ACP prompt.
 *
 * ACP adapters (e.g. codex-acp) frequently ack a failure with a generic
 * "Internal error" while printing the real cause to stderr as a JSON blob like
 * `{"error":{"message":"..."}}`. This picks the most specific signal available:
 * a structured stderr error, else the last stderr line, else the ack message.
 *
 * Pure and dependency-free.
 */

// CSI escape sequences (colour codes, cursor moves) that adapters interleave
// with their log lines: ESC `[`, parameter/intermediate bytes, then final byte.
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function deriveFailureError(ackMessage: string, stderr: string): string {
  const clean = stderr.replace(ANSI_ESCAPE, "").trim();

  // Most precise: a structured adapter error. Prefer it even over a specific
  // ack, but when it merely duplicates the ack, return the clean ack rather
  // than falling through to echo the raw JSON blob as a stderr line.
  const jsonMessage = lastJsonErrorMessage(clean);
  if (jsonMessage) return jsonMessage !== ackMessage ? jsonMessage : ackMessage;

  // An already-specific ack is preserved when stderr has no better detail.
  if (ackMessage.length > 0 && ackMessage !== "Internal error")
    return ackMessage;

  // Generic/empty ack: fall back to the last meaningful stderr line.
  return lastNonEmptyLine(clean) ?? ackMessage;
}

/**
 * Returns the `error.message` of the LAST JSON object embedded in `text` whose
 * shape is `{"error":{"message":"..."}}`, or null. Objects may be surrounded by
 * arbitrary log text.
 *
 * A candidate object is attempted at EACH `{`, so a stray unmatched `{` in the
 * surrounding log text never balances and is skipped rather than swallowing a
 * later valid object.
 */
function lastJsonErrorMessage(text: string): string | null {
  let found: string | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") {
      continue;
    }
    const candidate = balancedObjectAt(text, i);
    if (candidate === null) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as { error?: { message?: unknown } };
      // A valid top-level object: skip past its end so we don't restart
      // candidates at its nested braces. Otherwise a nested error.message
      // (e.g. a JSON-RPC error.data payload) would shadow the outer adapter
      // error. Only reached on a successful parse, so a stray unmatched brace
      // that balances-but-fails-to-parse still lets inner objects be scanned.
      i += candidate.length - 1;
      const message = parsed.error?.message;
      if (typeof message === "string" && message.length > 0) {
        found = message;
      }
    } catch {
      // Not valid JSON at this position; keep scanning later braces.
    }
  }
  return found;
}

/**
 * Returns the balanced `{...}` substring starting at `start`, tracking string
 * literals so braces inside JSON strings don't throw off the depth count, or
 * null if the braces never balance before the text ends.
 */
function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function lastNonEmptyLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
