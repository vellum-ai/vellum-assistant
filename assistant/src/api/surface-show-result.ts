/**
 * The `ui_show` tool-result envelope.
 *
 * A successful `ui_show` reports the created surface back to the model as a
 * JSON object carrying the `surfaceId`, optionally alongside advisory fields
 * (`status`, `note`, `message`) that coach the model on what to do next.
 *
 * The envelope is a contract, not just a string: the surface-completion nudge
 * reads `surfaceId` back out of tool history to tell which progress surfaces
 * the model left spinning. Producer and consumer therefore share this module,
 * so guidance can only ever be added in a way the parser still understands.
 */

/** Fields a `ui_show` result envelope may carry beyond the surface id. */
export interface SurfaceShowResult {
  surfaceId: string;
  [key: string]: unknown;
}

/**
 * Read the `surfaceId` out of a `ui_show` tool result, or `undefined` when the
 * content is not a surface envelope.
 *
 * Trailing prose after the JSON object is tolerated: guidance belongs in a
 * `note` field, but a caller that appends it instead must not silently cost
 * the reader its `surfaceId`: losing the id makes a live progress surface
 * invisible to the completion nudge, and the user watches it spin forever.
 */
export function parseSurfaceShowResultId(content: string): string | undefined {
  const parsed = parseLeadingJsonObject(content);
  return typeof parsed?.surfaceId === "string" ? parsed.surfaceId : undefined;
}

/**
 * Attach advisory guidance to a `ui_show` result as a `note` field, keeping the
 * content a single parseable JSON envelope. Content that is not a surface
 * envelope (an error string, a non-JSON acknowledgment) falls back to appending
 * the note as prose, which is still the right thing for the model to read.
 */
export function withSurfaceShowNote(content: string, note: string): string {
  const parsed = parseLeadingJsonObject(content);
  if (parsed === undefined || typeof parsed.surfaceId !== "string") {
    return `${content}\n\n${note}`;
  }
  const existing = typeof parsed.note === "string" ? parsed.note : undefined;
  return JSON.stringify({
    ...parsed,
    note: existing ? `${existing}\n\n${note}` : note,
  });
}

/**
 * Parse `content` as a JSON object, tolerating trailing text after the closing
 * brace. Returns `undefined` for anything that is not a leading JSON object.
 *
 * The object's extent is found by matching braces rather than by scanning for
 * the last `}`, because appended guidance routinely contains braces of its own
 * (a worked `ui_update { ... }` example, say).
 */
function parseLeadingJsonObject(
  content: string,
): Record<string, unknown> | undefined {
  const trimmed = content.trim();
  const end = endOfLeadingJsonObject(trimmed);
  if (end === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(0, end + 1));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Index of the `}` closing the object that opens `text`, or `undefined` when
 * `text` does not open with an object or the braces never balance. String
 * literals (and their escapes) are skipped so braces inside values don't count.
 */
function endOfLeadingJsonObject(text: string): number | undefined {
  if (!text.startsWith("{")) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return undefined;
}
