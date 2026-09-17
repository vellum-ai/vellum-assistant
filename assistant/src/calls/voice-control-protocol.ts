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
export const TASK_STOP_MARKER = "[TASK:STOP]";
export const TASK_UPDATE_SILENT_MARKER = "[TASK_UPDATE:SILENT]";

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

/**
 * Mic-mute session control for live voice: `[MUTE]` mutes until the user
 * unmutes, `[MUTE:<seconds>]` mutes for that long. Like {@link END_CALL_MARKER}
 * on a live-voice session, it is acted on only at the very end of a reply
 * (see {@link parseTerminalSessionControl}), after the acknowledgement that
 * precedes it has been spoken.
 */
export const MUTE_MARKER = "[MUTE]";
const MUTE_MARKER_PREFIX = "[MUTE:";

/** Longest timed mute a marker can ask for; longer asks mute until unmuted. */
export const MAX_TIMED_MUTE_SECONDS = 3600;

/**
 * Progress-update cadence for the rest of a live-voice session:
 * {@link FEWER_UPDATES_MARKER} after "don't give me updates so often",
 * {@link NORMAL_UPDATES_MARKER} to go back. Terminal like the other session
 * controls, but carried out by the session itself: narration is the daemon's.
 */
export const FEWER_UPDATES_MARKER = "[UPDATES:FEWER]";
export const NORMAL_UPDATES_MARKER = "[UPDATES:NORMAL]";
const UPDATES_MARKER_PREFIX = "[UPDATES:";

/**
 * Look session controls for live voice: turn on a screen share
 * ({@link LOOK_SCREEN_MARKER}) or the camera ({@link LOOK_CAMERA_MARKER}) so
 * the call can see what the user means by "take a look". Carried out by the
 * client, like mute and end.
 */
export const LOOK_SCREEN_MARKER = "[LOOK:SCREEN]";
export const LOOK_CAMERA_MARKER = "[LOOK:CAMERA]";
/** Stop showing the call the screen and the camera, whichever is on. */
export const LOOK_STOP_MARKER = "[LOOK:STOP]";
const LOOK_MARKER_PREFIX = "[LOOK:";

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
const TASK_STOP_MARKER_REGEX = /\[TASK:STOP\]/g;
const HOLD_VERDICT_TOKEN_REGEX = /\[0\]/g;
const ESCALATE_VERDICT_TOKEN_REGEX = /\[1\]/g;
const MINIMIZE_ROOM_MARKER_REGEX = /\[-1\]/g;
const MUTE_MARKER_REGEX = /\[MUTE(?::\s*[^\]]*)?\]/g;
const UPDATES_MARKER_REGEX = /\[UPDATES:\s*[^\]]*\]/g;
const LOOK_MARKER_REGEX = /\[LOOK:\s*[^\]]*\]/g;
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
    .replace(TASK_STOP_MARKER_REGEX, "")
    .replaceAll(TASK_UPDATE_SILENT_MARKER, "")
    .replace(HOLD_VERDICT_TOKEN_REGEX, "")
    .replace(ESCALATE_VERDICT_TOKEN_REGEX, "")
    .replace(MINIMIZE_ROOM_MARKER_REGEX, "")
    .replace(MUTE_MARKER_REGEX, "")
    .replace(UPDATES_MARKER_REGEX, "")
    .replace(LOOK_MARKER_REGEX, "")
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
  TASK_STOP_MARKER,
  TASK_UPDATE_SILENT_MARKER,
  "[0]",
  "[1]",
  "[-1]",
  MUTE_MARKER,
  MUTE_MARKER_PREFIX,
  UPDATES_MARKER_PREFIX,
  LOOK_MARKER_PREFIX,
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
  MUTE_MARKER_PREFIX,
  UPDATES_MARKER_PREFIX,
  LOOK_MARKER_PREFIX,
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

// ---------------------------------------------------------------------------
// Live-voice session controls
// ---------------------------------------------------------------------------

/**
 * A session control a live-voice reply asked for with a terminal marker:
 * `end` from {@link END_CALL_MARKER}, `task_stop` from
 * {@link TASK_STOP_MARKER}, `mute` from {@link MUTE_MARKER} or its timed form,
 * `updates` from the progress-cadence markers, and the look actions from the
 * look markers.
 */
export type SessionControlRequest =
  | { readonly action: "end" }
  | { readonly action: "task_stop" }
  | { readonly action: "mute"; readonly durationMs?: number }
  | { readonly action: "updates"; readonly cadence: "fewer" | "normal" }
  | { readonly action: "look_screen" }
  | { readonly action: "look_camera" }
  | { readonly action: "look_stop" };

const TERMINAL_SESSION_CONTROL_REGEX =
  /(\[END_CALL\]|\[TASK:STOP\]|\[UPDATES:(FEWER|NORMAL)\]|\[LOOK:(SCREEN|CAMERA|STOP)\]|\[MUTE\]|\[MUTE:\s*([^\]]*)\])\s*$/;

/**
 * The session control a reply ends with, or null.
 *
 * **Terminal position only.** The marker follows the spoken acknowledgement
 * ("Okay, talk soon."), so a reply that merely mentions a marker mid-text, or
 * parrots one from history before carrying on, controls nothing. This is the
 * same rule the minimize marker's transcript hygiene applies.
 *
 * A timed mute whose body is not a positive number of seconds degrades to an
 * untimed mute rather than to nothing: the user asked to be muted, and muting
 * until they unmute is the conservative reading of a garbled duration. Asks
 * past {@link MAX_TIMED_MUTE_SECONDS} degrade the same way.
 */
export function parseTerminalSessionControl(
  text: string,
): SessionControlRequest | null {
  const match = TERMINAL_SESSION_CONTROL_REGEX.exec(text);
  if (!match) {
    return null;
  }
  if (match[1] === END_CALL_MARKER) {
    return { action: "end" };
  }
  if (match[1] === TASK_STOP_MARKER) {
    return { action: "task_stop" };
  }
  if (match[2] !== undefined) {
    return {
      action: "updates",
      cadence: match[2] === "FEWER" ? "fewer" : "normal",
    };
  }
  if (match[3] !== undefined) {
    return {
      action:
        match[3] === "SCREEN"
          ? "look_screen"
          : match[3] === "CAMERA"
            ? "look_camera"
            : "look_stop",
    };
  }
  const seconds = match[4] === undefined ? NaN : Number(match[4].trim());
  if (
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds <= MAX_TIMED_MUTE_SECONDS
  ) {
    return { action: "mute", durationMs: Math.round(seconds * 1000) };
  }
  return { action: "mute" };
}

/**
 * Length of the marker a row's text ends with, ignoring trailing whitespace,
 * when it is one the transcript hygiene pass strips from the persisted row
 * (the minimize marker or a session control); 0 otherwise.
 */
export function terminalControlMarkerLength(text: string): number {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(TASK_UPDATE_SILENT_MARKER)) {
    return TASK_UPDATE_SILENT_MARKER.length;
  }
  if (trimmed.endsWith(MINIMIZE_ROOM_MARKER)) {
    return MINIMIZE_ROOM_MARKER.length;
  }
  return TERMINAL_SESSION_CONTROL_REGEX.exec(trimmed)?.[1]?.length ?? 0;
}
