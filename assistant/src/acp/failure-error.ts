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
 */
function lastJsonErrorMessage(text: string): string | null {
  const objects = extractJsonObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(objects[i]) as {
        error?: { message?: unknown };
      };
      const message = parsed.error?.message;
      if (typeof message === "string" && message.length > 0) return message;
    } catch {
      // Not valid JSON; keep scanning earlier candidates.
    }
  }
  return null;
}

/**
 * Extracts top-level balanced `{...}` substrings, tracking string literals so
 * braces inside JSON strings don't throw off the depth count.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function lastNonEmptyLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
