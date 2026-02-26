// Recording intent resolution for standalone screen recording routing.
// Exports `resolveRecordingIntent` as the single public entry point for
// text-based intent detection. Handlers use this (or structured
// `commandIntent` payloads) to intercept recording-related prompts
// before they reach the classifier or create a CU session.
//
// Internal helpers (detect/strip/classify) are kept as private utilities
// consumed only by `resolveRecordingIntent`.

type RecordingIntentClass = 'start_only' | 'stop_only' | 'mixed' | 'none';

export type RecordingIntentResult =
  | { kind: 'none' }
  | { kind: 'start_only' }
  | { kind: 'stop_only' }
  | { kind: 'start_with_remainder'; remainder: string }
  | { kind: 'stop_with_remainder'; remainder: string }
  | { kind: 'start_and_stop_only' }
  | { kind: 'start_and_stop_with_remainder'; remainder: string }
  | { kind: 'restart_only' }
  | { kind: 'restart_with_remainder'; remainder: string }
  | { kind: 'pause_only' }
  | { kind: 'resume_only' };

// ─── Start recording patterns ────────────────────────────────────────────────

const START_RECORDING_PATTERNS: RegExp[] = [
  /\brecord\s+(my\s+)?screen\b/i,
  /\brecord\s+the\s+screen\b/i,
  /\bscreen\s+record(ing)?\b/i,
  /\bstart\s+recording\b/i,
  /\bbegin\s+recording\b/i,
  /\bcapture\s+(my\s+)?(screen|display)\b/i,
  /\bmake\s+a\s+(screen\s+)?recording\b/i,
];

// ─── Stop recording patterns ────────────────────────────────────────────────

const STOP_RECORDING_PATTERNS: RegExp[] = [
  /\bstop\s+(the\s+)?recording\b/i,
  /\bend\s+(the\s+)?recording\b/i,
  /\bfinish\s+(the\s+)?recording\b/i,
  /\bhalt\s+(the\s+)?recording\b/i,
];

// ─── Restart recording patterns (compound: stop + start a new one) ──────────

const RESTART_RECORDING_PATTERNS: RegExp[] = [
  /\brestart\s+(the\s+)?recording\b/i,
  /\bredo\s+(the\s+)?recording\b/i,
  /\bstop\s+(the\s+)?recording\s+and\s+(start|begin)\s+(a\s+)?(new|fresh|another)\s+(recording|one)\b/i,
  /\bstop\s+(the\s+)?recording\s+and\s+(start|begin)\s+(a\s+)?(new|fresh|another)\s*$/i,
  /\bstop\s+and\s+restart\s+(the\s+)?recording\b/i,
  /\bstop\s+recording\s+and\s+start\s+(a\s+)?(new|another|fresh)\s+(recording|one)\b/i,
  /\bstop\s+recording\s+and\s+start\s+(a\s+)?(new|another|fresh)\s*$/i,
];

// ─── Pause/resume recording patterns ────────────────────────────────────────

const PAUSE_RECORDING_PATTERNS: RegExp[] = [
  /\bpause\s+(the\s+)?recording\b/i,
];

const RESUME_RECORDING_PATTERNS: RegExp[] = [
  /\bresume\s+(the\s+)?recording\b/i,
  /\bunpause\s+(the\s+)?recording\b/i,
];

// ─── Stop-recording clause removal for mixed-intent prompts ─────────────────

const STOP_RECORDING_CLAUSE_PATTERNS: RegExp[] = [
  /\b(and\s+)?(also\s+)?stop\s+(the\s+)?recording\b/i,
  /\b(and\s+)?(also\s+)?end\s+(the\s+)?recording\b/i,
  /\b(and\s+)?(also\s+)?finish\s+(the\s+)?recording\b/i,
  /\b(and\s+)?(also\s+)?halt\s+(the\s+)?recording\b/i,
];

// ─── Clause removal for mixed-intent prompts ─────────────────────────────────

const RECORDING_CLAUSE_PATTERNS: RegExp[] = [
  /\b(and\s+)?(also\s+)?record\s+(my\s+|the\s+)?screen\b/i,
  /\b(and\s+)?(also\s+)?screen\s+record(ing)?\b/i,
  /\b(and\s+)?(also\s+)?start\s+recording\b/i,
  /\b(and\s+)?(also\s+)?begin\s+recording\b/i,
  /\b(and\s+)?(also\s+)?capture\s+(my\s+)?(screen|display)\b/i,
  /\b(and\s+)?(also\s+)?make\s+a\s+(screen\s+)?recording\b/i,
  /\bwhile\s+(you\s+)?record(ing)?\s+(my\s+|the\s+)?screen\b/i,
  /\brecord\s+(my\s+|the\s+)?screen\s+while\b/i,
];

// ─── Restart clause removal ─────────────────────────────────────────────────

const RESTART_RECORDING_CLAUSE_PATTERNS: RegExp[] = [
  // Longer compound patterns first — avoids partial matches by shorter patterns
  /\bstop\s+(the\s+)?recording\s+and\s+(start|begin)\s+(a\s+)?(new|fresh|another)\s+(recording|one)\b/i,
  /\bstop\s+(the\s+)?recording\s+and\s+(start|begin)\s+(a\s+)?(new|fresh|another)\s*$/i,
  /\bstop\s+and\s+restart\s+(the\s+)?recording\b/i,
  /\bstop\s+recording\s+and\s+start\s+(a\s+)?(new|another|fresh)\s+(recording|one)\b/i,
  /\bstop\s+recording\s+and\s+start\s+(a\s+)?(new|another|fresh)\s*$/i,
  /\b(and\s+)?(also\s+)?restart\s+(the\s+)?recording\b/i,
  /\b(and\s+)?(also\s+)?redo\s+(the\s+)?recording\b/i,
];

// ─── Pause/resume clause removal ────────────────────────────────────────────

const PAUSE_RECORDING_CLAUSE_PATTERNS: RegExp[] = [
  /\b(and\s+)?(also\s+)?pause\s+(the\s+)?recording\b/i,
];

const RESUME_RECORDING_CLAUSE_PATTERNS: RegExp[] = [
  /\b(and\s+)?(also\s+)?resume\s+(the\s+)?recording\b/i,
  /\b(and\s+)?(also\s+)?unpause\s+(the\s+)?recording\b/i,
];

/** Common polite/filler words stripped before checking intent-only status. */
const FILLER_PATTERN =
  /\b(please|pls|plz|can\s+you|could\s+you|would\s+you|now|right\s+now|thanks|thank\s+you|thx|ty|for\s+me|ok(ay)?|hey|hi|just)\b/gi;

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Returns true if the user's message includes any recording-related phrases.
 * Does not distinguish between recording-only and mixed-intent prompts.
 */
function detectRecordingIntent(taskText: string): boolean {
  return START_RECORDING_PATTERNS.some((p) => p.test(taskText));
}

/**
 * Returns true if the prompt is purely about recording with no additional task.
 * "record my screen" -> true
 * "record my screen while I work" -> false (has CU task component)
 * "open Chrome and record my screen" -> false (has CU task component)
 */
function isRecordingOnly(taskText: string): boolean {
  if (!detectRecordingIntent(taskText)) return false;

  // Strip the recording clause and check if anything substantive remains
  const stripped = stripRecordingIntent(taskText);
  // Also remove common polite/filler words that don't change the intent
  const withoutFillers = stripped.replace(FILLER_PATTERN, '');
  // If after removing the recording clause and fillers, only whitespace/punctuation
  // remains, this is a recording-only prompt.
  return withoutFillers.replace(/[.,;!?\s]+/g, '').length === 0;
}

/**
 * Returns true if the user wants to stop recording.
 * Requires explicit "stop/end/finish/halt recording" phrasing --
 * bare "stop", "end it", or "quit" are too ambiguous and will not match.
 */
function detectStopRecordingIntent(taskText: string): boolean {
  return STOP_RECORDING_PATTERNS.some((p) => p.test(taskText));
}

/** Returns true if any restart compound pattern matches. */
function detectRestartRecordingIntent(taskText: string): boolean {
  return RESTART_RECORDING_PATTERNS.some((p) => p.test(taskText));
}

/** Returns true if any pause pattern matches. */
function detectPauseRecordingIntent(taskText: string): boolean {
  return PAUSE_RECORDING_PATTERNS.some((p) => p.test(taskText));
}

/** Returns true if any resume pattern matches. */
function detectResumeRecordingIntent(taskText: string): boolean {
  return RESUME_RECORDING_PATTERNS.some((p) => p.test(taskText));
}

/**
 * Removes recording-related clauses from a task, returning the cleaned text.
 * Used when a recording intent is embedded in a broader CU task so the
 * recording portion can be handled separately while the task continues.
 */
function stripRecordingIntent(taskText: string): string {
  let result = taskText;
  for (const pattern of RECORDING_CLAUSE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  // Clean up any leftover double spaces or leading/trailing whitespace
  return result.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Removes stop-recording clauses from a message, returning the cleaned text.
 * Analogous to stripRecordingIntent but for stop-recording phrases.
 */
function stripStopRecordingIntent(taskText: string): string {
  let result = taskText;
  for (const pattern of STOP_RECORDING_CLAUSE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

/** Removes restart-recording clauses from text. */
function stripRestartRecordingIntent(taskText: string): string {
  let result = taskText;
  for (const pattern of RESTART_RECORDING_CLAUSE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

/** Removes pause-recording clauses from text. */
function stripPauseRecordingIntent(taskText: string): string {
  let result = taskText;
  for (const pattern of PAUSE_RECORDING_CLAUSE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

/** Removes resume-recording clauses from text. */
function stripResumeRecordingIntent(taskText: string): string {
  let result = taskText;
  for (const pattern of RESUME_RECORDING_CLAUSE_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Returns true if the prompt is purely about stopping recording with no
 * additional task. Analogous to isRecordingOnly but for stop-recording.
 * "stop recording" -> true
 * "how do I stop recording?" -> false (has additional context)
 * "stop recording and close the browser" -> false (has CU task component)
 */
function isStopRecordingOnly(taskText: string): boolean {
  if (!detectStopRecordingIntent(taskText)) return false;

  const stripped = stripStopRecordingIntent(taskText);
  // Also remove common polite/filler words that don't change the intent
  const withoutFillers = stripped.replace(FILLER_PATTERN, '');
  return withoutFillers.replace(/[.,;!?\s]+/g, '').length === 0;
}

/** Returns true if the text is purely a restart command (no additional task). */
function isRestartRecordingOnly(taskText: string): boolean {
  if (!detectRestartRecordingIntent(taskText)) return false;
  const stripped = stripRestartRecordingIntent(taskText);
  const withoutFillers = stripped.replace(FILLER_PATTERN, '');
  return withoutFillers.replace(/[.,;!?\s]+/g, '').length === 0;
}

/** Returns true if the text is purely a pause command (no additional task). */
function isPauseRecordingOnly(taskText: string): boolean {
  if (!detectPauseRecordingIntent(taskText)) return false;
  const stripped = stripPauseRecordingIntent(taskText);
  const withoutFillers = stripped.replace(FILLER_PATTERN, '');
  return withoutFillers.replace(/[.,;!?\s]+/g, '').length === 0;
}

/** Returns true if the text is purely a resume command (no additional task). */
function isResumeRecordingOnly(taskText: string): boolean {
  if (!detectResumeRecordingIntent(taskText)) return false;
  const stripped = stripResumeRecordingIntent(taskText);
  const withoutFillers = stripped.replace(FILLER_PATTERN, '');
  return withoutFillers.replace(/[.,;!?\s]+/g, '').length === 0;
}

// ─── Dynamic name normalization ─────────────────────────────────────────────

/**
 * Strips dynamic assistant name aliases from the beginning of text.
 * Handles patterns like "Nova, ...", "Nova ...", "hey Nova, ...", "hey, Nova, ..." (case-insensitive).
 * Periods in names are optional to handle natural omission (e.g., "Jr" vs "Jr.").
 */
export function stripDynamicNames(text: string, dynamicNames: string[]): string {
  let result = text;
  for (const name of dynamicNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Make escaped periods optional — users often omit dots (e.g., "Jr" vs "Jr.")
    const withOptionalDots = escaped.replace(/\\\./g, '\\.?');
    // "hey <name>, ..." / "hey <name> ..." / "hey, <name>, ..."
    // Lookahead ensures the name is a whole token (not a prefix of a longer word).
    const heyPattern = new RegExp(`^hey[,\\s]+${withOptionalDots}(?=[,:\\s]|$)[,:]?\\s*`, 'i');
    // "<name>, ..." or "<name> ..."
    const namePattern = new RegExp(`^${withOptionalDots}(?=[,:\\s]|$)[,:]?\\s*`, 'i');
    result = result.replace(heyPattern, '');
    result = result.replace(namePattern, '');
  }
  return result.trim();
}

/**
 * Returns true if the text contains substantive content beyond fillers,
 * punctuation, and dynamic assistant names. Used to determine whether
 * remaining text after stripping recording clauses needs further processing.
 */
function hasSubstantiveContent(text: string, dynamicNames?: string[]): boolean {
  let cleaned = text;
  if (dynamicNames && dynamicNames.length > 0) {
    cleaned = stripDynamicNames(cleaned, dynamicNames);
  }
  cleaned = cleaned.replace(FILLER_PATTERN, '');
  return cleaned.replace(/[.,;!?\s]+/g, '').length > 0;
}

// ─── Interrogative detection ────────────────────────────────────────────────

/** WH-question starters — these almost always indicate a genuine question,
 *  not an imperative command. Prevents "how do I stop recording?" from
 *  triggering recording side effects in the mixed handler. */
const WH_INTERROGATIVE = /^\s*(how|what|why|when|where|who|which)\b/i;

/**
 * Returns true if the text appears to be a question about recording rather
 * than an imperative command that includes recording.
 *
 * "how do I stop recording?" → true  (question — don't trigger side effects)
 * "open Chrome and record my screen" → false  (command — trigger recording)
 * "can you record my screen?" → false  (polite imperative — trigger recording)
 */
function isInterrogative(text: string, dynamicNames?: string[]): boolean {
  let cleaned = text;
  if (dynamicNames && dynamicNames.length > 0) {
    cleaned = stripDynamicNames(cleaned, dynamicNames);
  }
  // Strip polite prefixes that don't change interrogative status
  cleaned = cleaned.replace(/^\s*(hey|hi|hello|please|pls|plz)[,\s]+/i, '');
  return WH_INTERROGATIVE.test(cleaned);
}

// ─── Unified classification ─────────────────────────────────────────────────

/**
 * Classifies the recording intent of a user message into one of four categories:
 * - 'start_only': the prompt is purely about starting a recording
 * - 'stop_only': the prompt is purely about stopping a recording
 * - 'mixed': the prompt contains recording intent mixed with other tasks,
 *            or contains both start and stop recording patterns
 * - 'none': no recording intent detected
 *
 * If `dynamicNames` are provided, they are stripped from the beginning of the
 * text before classification (e.g., "Nova, record my screen" -> "record my screen").
 */
function classifyRecordingIntent(
  taskText: string,
  dynamicNames?: string[],
): RecordingIntentClass {
  const normalized =
    dynamicNames && dynamicNames.length > 0
      ? stripDynamicNames(taskText, dynamicNames)
      : taskText;

  const hasStart = detectRecordingIntent(normalized);
  const hasStop = detectStopRecordingIntent(normalized);

  // Both start and stop patterns present -> mixed
  if (hasStart && hasStop) return 'mixed';

  if (hasStop) {
    return isStopRecordingOnly(normalized) ? 'stop_only' : 'mixed';
  }

  if (hasStart) {
    return isRecordingOnly(normalized) ? 'start_only' : 'mixed';
  }

  return 'none';
}

// ─── Structured intent resolver ─────────────────────────────────────────────

/**
 * Resolves recording intent from user text into a structured result that
 * distinguishes pure recording commands from commands with remaining task text.
 *
 * Pipeline:
 * 1. Strip dynamic assistant names (leading vocative)
 * 2. Strip leading polite wrappers
 * 3. Interrogative gate — questions return `none`
 * 3.5. Restart compound detection (before independent start/stop)
 * 3.6. Pause/resume detection
 * 4. Detect start/stop patterns (start takes precedence when both present)
 * 5. Determine if recording-only or has a remainder, stripping from the
 *    ORIGINAL text to preserve the user's exact phrasing
 */
export function resolveRecordingIntent(
  text: string,
  dynamicNames?: string[],
): RecordingIntentResult {
  // Step 1: Strip dynamic assistant names for normalization
  let normalized =
    dynamicNames && dynamicNames.length > 0
      ? stripDynamicNames(text, dynamicNames)
      : text;

  // Step 2: Strip leading polite wrappers for normalization
  normalized = normalized.replace(/^\s*(hey|hi|hello|please|pls|plz)[,\s]+/i, '');

  // Step 3: Interrogative gate — WH-questions are not commands
  if (WH_INTERROGATIVE.test(normalized)) {
    return { kind: 'none' };
  }

  // Step 3.5: Restart compound detection — check BEFORE independent start/stop
  // so "stop recording and start a new one" is recognized as restart, not
  // as separate stop + start patterns.
  if (detectRestartRecordingIntent(normalized)) {
    if (isRestartRecordingOnly(normalized)) {
      return { kind: 'restart_only' };
    }
    // Strip from the ORIGINAL text to preserve user's exact phrasing
    const remainder = stripRestartRecordingIntent(text);
    if (hasSubstantiveContent(remainder, dynamicNames)) {
      return { kind: 'restart_with_remainder', remainder };
    }
    return { kind: 'restart_only' };
  }

  // Step 3.6: Pause/resume detection — check before start/stop
  if (detectPauseRecordingIntent(normalized)) {
    if (isPauseRecordingOnly(normalized)) {
      return { kind: 'pause_only' };
    }
    // Pause with additional text falls through to normal processing
  }

  if (detectResumeRecordingIntent(normalized)) {
    if (isResumeRecordingOnly(normalized)) {
      return { kind: 'resume_only' };
    }
    // Resume with additional text falls through to normal processing
  }

  // Step 4: Detect start and stop patterns on the normalized text
  const hasStart = detectRecordingIntent(normalized);
  const hasStop = detectStopRecordingIntent(normalized);

  // Step 5: Resolve
  if (hasStart) {
    if (hasStop) {
      // Both start and stop detected — use combined variants
      if (isRecordingOnly(normalized)) {
        // Check if stop-only after stripping start patterns
        const withoutStart = stripRecordingIntent(normalized);
        if (isStopRecordingOnly(withoutStart)) {
          return { kind: 'start_and_stop_only' };
        }
      }
      let remainder = stripRecordingIntent(text);
      remainder = stripStopRecordingIntent(remainder);
      if (hasSubstantiveContent(remainder, dynamicNames)) {
        return { kind: 'start_and_stop_with_remainder', remainder };
      }
      return { kind: 'start_and_stop_only' };
    }
    // Only start detected
    if (isRecordingOnly(normalized)) {
      return { kind: 'start_only' };
    }
    // Strip from the ORIGINAL text to preserve user's exact phrasing
    const remainder = stripRecordingIntent(text);
    if (hasSubstantiveContent(remainder, dynamicNames)) {
      return { kind: 'start_with_remainder', remainder };
    }
    return { kind: 'start_only' };
  }

  if (hasStop) {
    if (isStopRecordingOnly(normalized)) {
      return { kind: 'stop_only' };
    }
    // Strip from the ORIGINAL text to preserve user's exact phrasing
    const remainder = stripStopRecordingIntent(text);
    if (hasSubstantiveContent(remainder, dynamicNames)) {
      return { kind: 'stop_with_remainder', remainder };
    }
    return { kind: 'stop_only' };
  }

  return { kind: 'none' };
}
