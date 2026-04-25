/**
 * Voice call control marker constants, regexes, and stripping utilities.
 *
 * Centralizes all marker definitions so call-controller.ts and
 * voice-session-bridge.ts share a single source of truth.
 */

// ---------------------------------------------------------------------------
// String constants
// ---------------------------------------------------------------------------

export const CALL_OPENING_MARKER = "[CALL_OPENING]";
export const CALL_OPENING_ACK_MARKER = "[CALL_OPENING_ACK]";
export const CALL_VERIFICATION_COMPLETE_MARKER = "[CALL_VERIFICATION_COMPLETE]";
export const END_CALL_MARKER = "[END_CALL]";

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

export const ASK_GUARDIAN_CAPTURE_REGEX = /\[ASK_GUARDIAN:\s*(.+?)\]/;
export const ASK_GUARDIAN_MARKER_REGEX = /\[ASK_GUARDIAN:\s*.+?\]/g;

// Flexible prefix for ASK_GUARDIAN_APPROVAL — tolerates variable whitespace
// after the colon so the marker is recognized even if the model omits the
// space or inserts a newline.
export const ASK_GUARDIAN_APPROVAL_PREFIX_RE = /\[ASK_GUARDIAN_APPROVAL:\s*/;

export const USER_ANSWERED_MARKER_REGEX = /\[USER_ANSWERED:\s*.+?\]/g;
export const USER_INSTRUCTION_MARKER_REGEX = /\[USER_INSTRUCTION:\s*.+?\]/g;
export const CALL_OPENING_MARKER_REGEX = /\[CALL_OPENING\]/g;
export const CALL_OPENING_ACK_MARKER_REGEX = /\[CALL_OPENING_ACK\]/g;
export const END_CALL_MARKER_REGEX = /\[END_CALL\]/g;
export const GUARDIAN_TIMEOUT_MARKER_REGEX = /\[GUARDIAN_TIMEOUT\]/g;
export const GUARDIAN_UNAVAILABLE_MARKER_REGEX = /\[GUARDIAN_UNAVAILABLE\]/g;

// ---------------------------------------------------------------------------
// Balanced JSON extraction (used by stripGuardianApprovalMarkers)
// ---------------------------------------------------------------------------

/**
 * Extract a balanced JSON object from text that starts with an
 * ASK_GUARDIAN_APPROVAL prefix. Uses brace counting with string-literal
 * awareness so that `}` or `}]` inside JSON string values does not
 * terminate the match prematurely.
 *
 * Returns the extracted JSON string, the full marker text
 * (prefix + JSON + "]"), and the start index — or null when:
 *   - no prefix is found,
 *   - braces are unbalanced (still streaming), or
 *   - the closing `]` has not yet arrived (prevents stripping
 *     the marker body while the bracket leaks into TTS in a later delta).
 */
export function extractBalancedJson(
  text: string,
): { json: string; fullMatch: string; startIndex: number } | null {
  const prefixMatch = ASK_GUARDIAN_APPROVAL_PREFIX_RE.exec(text);
  if (!prefixMatch) return null;

  const prefixIdx = prefixMatch.index;
  const jsonStart = prefixIdx + prefixMatch[0].length;
  if (jsonStart >= text.length || text[jsonStart] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const jsonEnd = i + 1;
        const json = text.slice(jsonStart, jsonEnd);
        // Skip any whitespace between the closing '}' and the expected ']'.
        // Models sometimes emit formatted markers with spaces or newlines
        // before the bracket (e.g. `{ ... }\n]` or `{ ... } ]`).
        let bracketIdx = jsonEnd;
        while (bracketIdx < text.length && /\s/.test(text[bracketIdx])) {
          bracketIdx++;
        }
        // Require the closing ']' to be present before considering this
        // a complete match. If it hasn't arrived yet (streaming), return
        // null so the caller keeps buffering.
        if (bracketIdx >= text.length || text[bracketIdx] !== "]") {
          return null;
        }
        const fullMatchEnd = bracketIdx + 1;
        const fullMatch = text.slice(prefixIdx, fullMatchEnd);
        return { json, fullMatch, startIndex: prefixIdx };
      }
    }
  }

  return null; // Unbalanced braces — still streaming
}

// ---------------------------------------------------------------------------
// Marker stripping
// ---------------------------------------------------------------------------

/**
 * Strip all balanced ASK_GUARDIAN_APPROVAL markers from text, handling
 * nested braces, string literals, and flexible whitespace correctly.
 * Only strips complete markers (prefix + balanced JSON + closing `]`).
 */
function stripGuardianApprovalMarkers(text: string): string {
  let result = text;
  for (;;) {
    const match = extractBalancedJson(result);
    if (!match) break;
    result =
      result.slice(0, match.startIndex) +
      result.slice(match.startIndex + match.fullMatch.length);
  }
  return result;
}

export function stripInternalSpeechMarkers(text: string): string {
  let result = stripGuardianApprovalMarkers(text);
  result = result
    .replace(ASK_GUARDIAN_MARKER_REGEX, "")
    .replace(USER_ANSWERED_MARKER_REGEX, "")
    .replace(USER_INSTRUCTION_MARKER_REGEX, "")
    .replace(CALL_OPENING_MARKER_REGEX, "")
    .replace(CALL_OPENING_ACK_MARKER_REGEX, "")
    .replace(END_CALL_MARKER_REGEX, "")
    .replace(GUARDIAN_TIMEOUT_MARKER_REGEX, "")
    .replace(GUARDIAN_UNAVAILABLE_MARKER_REGEX, "");
  return result;
}

// ---------------------------------------------------------------------------
// Control marker detection
// ---------------------------------------------------------------------------

/**
 * All known control marker prefixes. Used by couldBeControlMarker to detect
 * whether a buffer that starts with `[` might be the beginning of a control
 * marker (and should therefore be held rather than flushed to TTS).
 */
const CONTROL_MARKER_STRINGS = [
  "[ASK_GUARDIAN_APPROVAL:",
  "[ASK_GUARDIAN:",
  "[USER_ANSWERED:",
  "[USER_INSTRUCTION:",
  "[CALL_OPENING]",
  "[CALL_OPENING_ACK]",
  "[END_CALL]",
  "[GUARDIAN_TIMEOUT]",
  "[GUARDIAN_UNAVAILABLE]",
];

/**
 * Check whether `text` could be a partial or complete control marker.
 *
 * Returns true if any known marker string is a prefix of `text`
 * (text starts with the marker) or `text` is a prefix of a marker
 * (the marker starts with text — i.e. text is still being streamed).
 */
export function couldBeControlMarker(text: string): boolean {
  return CONTROL_MARKER_STRINGS.some(
    (marker) => marker.startsWith(text) || text.startsWith(marker),
  );
}
