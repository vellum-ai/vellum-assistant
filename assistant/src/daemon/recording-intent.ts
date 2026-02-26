// Recording intent detection for standalone screen recording routing.
// Used by task/message handlers to intercept recording-related prompts
// before they reach the classifier or create a CU session.

export type RecordingIntentClass = 'start_only' | 'stop_only' | 'mixed' | 'none';

export type RecordingIntentResult =
  | { kind: 'none' }
  | { kind: 'start_only' }
  | { kind: 'stop_only' }
  | { kind: 'start_with_remainder'; remainder: string }
  | { kind: 'stop_with_remainder'; remainder: string };

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

/** Common polite/filler words stripped before checking intent-only status. */
const FILLER_PATTERN =
  /\b(please|pls|plz|can\s+you|could\s+you|would\s+you|now|right\s+now|thanks|thank\s+you|thx|ty|for\s+me|ok(ay)?|hey|hi|just)\b/gi;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns true if the user's message includes any recording-related phrases.
 * Does not distinguish between recording-only and mixed-intent prompts.
 */
export function detectRecordingIntent(taskText: string): boolean {
  return START_RECORDING_PATTERNS.some((p) => p.test(taskText));
}

/**
 * Returns true if the prompt is purely about recording with no additional task.
 * "record my screen" -> true
 * "record my screen while I work" -> false (has CU task component)
 * "open Chrome and record my screen" -> false (has CU task component)
 */
export function isRecordingOnly(taskText: string): boolean {
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
export function detectStopRecordingIntent(taskText: string): boolean {
  return STOP_RECORDING_PATTERNS.some((p) => p.test(taskText));
}

/**
 * Removes recording-related clauses from a task, returning the cleaned text.
 * Used when a recording intent is embedded in a broader CU task so the
 * recording portion can be handled separately while the task continues.
 */
export function stripRecordingIntent(taskText: string): string {
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
export function stripStopRecordingIntent(taskText: string): string {
  let result = taskText;
  for (const pattern of STOP_RECORDING_CLAUSE_PATTERNS) {
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
export function isStopRecordingOnly(taskText: string): boolean {
  if (!detectStopRecordingIntent(taskText)) return false;

  const stripped = stripStopRecordingIntent(taskText);
  // Also remove common polite/filler words that don't change the intent
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
export function hasSubstantiveContent(text: string, dynamicNames?: string[]): boolean {
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
export function isInterrogative(text: string, dynamicNames?: string[]): boolean {
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
export function classifyRecordingIntent(
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

  // Step 4: Detect start and stop patterns on the normalized text
  const hasStart = detectRecordingIntent(normalized);
  const hasStop = detectStopRecordingIntent(normalized);

  // Step 5: Resolve — start takes precedence when both are present
  if (hasStart) {
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
