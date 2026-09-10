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

/**
 * Verdict tokens for the fast "front-door" model (triage-and-escalate voice
 * routing — see voice-triage-escalate.ts). The protocol is verdict-first:
 * the leg's output must BEGIN with its verdict on the turn —
 * {@link HOLD_VERDICT_TOKEN} (the caller is mid-thought; unified front-door
 * only), {@link ESCALATE_VERDICT_TOKEN} followed by one short spoken holding
 * phrase (the turn is handed to the stronger model), or neither, in which
 * case the output IS the answer. Bracketed like every other control marker
 * so the shared partial-marker holdback and stripping apply; like the other
 * markers they are swallowed before reaching TTS — never spoken aloud.
 */
export const HOLD_VERDICT_TOKEN = "[0]";
export const ESCALATE_VERDICT_TOKEN = "[1]";

/**
 * Room-minimize token, kept in the marker table so it is stripped from
 * speech and from persisted rows. No prompt teaches it: the live-voice
 * session decides a minimize from whether a ui-surface tool ran during the
 * turn (`revealsUiSurface` on `tool_result`) and sends the `minimize_room`
 * frame itself, so a model that emits this token regardless moves nothing.
 */
export const MINIMIZE_ROOM_MARKER = "[-1]";

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

export const ASK_GUARDIAN_CAPTURE_REGEX = /\[ASK_GUARDIAN:\s*(.+?)\]/;
const ASK_GUARDIAN_MARKER_REGEX = /\[ASK_GUARDIAN:\s*.+?\]/g;

// Flexible prefix for ASK_GUARDIAN_APPROVAL — tolerates variable whitespace
// after the colon so the marker is recognized even if the model omits the
// space or inserts a newline.
const ASK_GUARDIAN_APPROVAL_PREFIX_RE = /\[ASK_GUARDIAN_APPROVAL:\s*/;

const USER_ANSWERED_MARKER_REGEX = /\[USER_ANSWERED:\s*.+?\]/g;
const USER_INSTRUCTION_MARKER_REGEX = /\[USER_INSTRUCTION:\s*.+?\]/g;
const CALL_OPENING_MARKER_REGEX = /\[CALL_OPENING\]/g;
const CALL_OPENING_ACK_MARKER_REGEX = /\[CALL_OPENING_ACK\]/g;
const END_CALL_MARKER_REGEX = /\[END_CALL\]/g;
const HOLD_VERDICT_TOKEN_REGEX = /\[0\]/g;
const ESCALATE_VERDICT_TOKEN_REGEX = /\[1\]/g;
const MINIMIZE_ROOM_MARKER_REGEX = /\[-1\]/g;
const GUARDIAN_TIMEOUT_MARKER_REGEX = /\[GUARDIAN_TIMEOUT\]/g;
const GUARDIAN_UNAVAILABLE_MARKER_REGEX = /\[GUARDIAN_UNAVAILABLE\]/g;

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
  if (!prefixMatch) {
    return null;
  }

  const prefixIdx = prefixMatch.index;
  const jsonStart = prefixIdx + prefixMatch[0].length;
  if (jsonStart >= text.length || text[jsonStart] !== "{") {
    return null;
  }

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

    if (inString) {
      continue;
    }

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
    if (!match) {
      break;
    }
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
    .replace(HOLD_VERDICT_TOKEN_REGEX, "")
    .replace(ESCALATE_VERDICT_TOKEN_REGEX, "")
    .replace(MINIMIZE_ROOM_MARKER_REGEX, "")
    .replace(GUARDIAN_TIMEOUT_MARKER_REGEX, "")
    .replace(GUARDIAN_UNAVAILABLE_MARKER_REGEX, "");
  return result;
}

// ---------------------------------------------------------------------------
// Control marker detection
// ---------------------------------------------------------------------------

/**
 * All known control marker prefixes. Used by isIncompleteControlMarkerTail to
 * detect whether a buffer that starts with `[` might be the beginning of a
 * control marker (and should therefore be held rather than flushed to TTS).
 */
const CONTROL_MARKER_STRINGS = [
  "[ASK_GUARDIAN_APPROVAL:",
  "[ASK_GUARDIAN:",
  "[USER_ANSWERED:",
  "[USER_INSTRUCTION:",
  "[CALL_OPENING]",
  "[CALL_OPENING_ACK]",
  "[END_CALL]",
  "[0]",
  "[1]",
  "[-1]",
  "[GUARDIAN_TIMEOUT]",
  "[GUARDIAN_UNAVAILABLE]",
];

// Colon-style markers whose bodies terminate at the first "]" — their strip
// regexes are non-greedy (`.+?\]`), so the first bracket IS the terminator.
// ASK_GUARDIAN_APPROVAL is deliberately absent: its balanced-JSON body may
// itself contain "]" (arrays, string values), so only the balanced parser can
// judge it complete.
const FIRST_BRACKET_TERMINATED_PREFIXES = [
  "[ASK_GUARDIAN:",
  "[USER_ANSWERED:",
  "[USER_INSTRUCTION:",
];

const GUARDIAN_APPROVAL_PREFIX = "[ASK_GUARDIAN_APPROVAL:";

/**
 * Whether `tail` (a buffer starting at a `[`) is a control marker that is
 * still streaming — i.e. holding it back is required because
 * {@link stripInternalSpeechMarkers} cannot yet remove it. Returns false for
 * complete markers (safe to flush: stripping removes them) and for text that
 * is not a marker at all (safe to flush: it is speech).
 *
 * Completion is judged per marker family: a strict prefix of any known
 * marker string is always incomplete; an ASK_GUARDIAN_APPROVAL body is
 * complete only when {@link extractBalancedJson} finds the balanced JSON and
 * its closing bracket (a bare "]" inside the JSON does NOT terminate it);
 * the other colon-style markers terminate at their first "]"; the fixed
 * literal markers are complete the moment they match.
 */
export function isIncompleteControlMarkerTail(tail: string): boolean {
  if (
    CONTROL_MARKER_STRINGS.some(
      (marker) => marker.length > tail.length && marker.startsWith(tail),
    )
  ) {
    return true;
  }
  if (tail.startsWith(GUARDIAN_APPROVAL_PREFIX)) {
    return extractBalancedJson(tail) === null;
  }
  if (FIRST_BRACKET_TERMINATED_PREFIXES.some((p) => tail.startsWith(p))) {
    return !tail.includes("]");
  }
  return false;
}

/**
 * Control-marker hygiene for one model leg's streamed text, shared by the
 * phone call controller and the live-voice session. The returned flush is
 * called with the leg's cumulative raw text so far and forwards, through
 * `emit`, the stripped ({@link stripInternalSpeechMarkers}) prefix that has
 * not been emitted yet and cannot contain a still-streaming control marker:
 * the flush stops at the first "[" whose tail is an incomplete marker
 * ({@link isIncompleteControlMarkerTail}) and holds from there until a later
 * delta completes or disproves it. `force` (leg completion) emits the held
 * tail so real text that merely resembles a marker prefix is not dropped.
 *
 * The scan runs forward from the emitted boundary, not from the last "[", so
 * brackets INSIDE a streaming marker body (a JSON array or "]"-bearing string
 * in ASK_GUARDIAN_APPROVAL) can neither mask the marker's start nor pass as
 * its terminator. Markers are stripped, never acted on: a consumer that acts
 * on a marker reads the leg's full raw text for it separately.
 */
export function createControlMarkerHoldback(
  emit: (chunk: string) => void,
): (raw: string, opts?: { force?: boolean }) => void {
  let emitted = 0;
  return (raw, opts) => {
    let safeEnd = raw.length;
    if (opts?.force !== true) {
      for (
        let i = raw.indexOf("[", emitted);
        i !== -1;
        i = raw.indexOf("[", i + 1)
      ) {
        if (isIncompleteControlMarkerTail(raw.slice(i))) {
          safeEnd = i;
          break;
        }
      }
    }
    if (safeEnd > emitted) {
      const chunk = stripInternalSpeechMarkers(raw.slice(emitted, safeEnd));
      emitted = safeEnd;
      if (chunk.length > 0) {
        emit(chunk);
      }
    }
  };
}
