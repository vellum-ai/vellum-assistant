// Recording intent detection for standalone screen recording routing.
// Used by task/message handlers to intercept recording-related prompts
// before they reach the classifier or create a CU session.

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
  // If after removing the recording clause, only whitespace/punctuation remains,
  // this is a recording-only prompt.
  return stripped.replace(/[.,;!?\s]+/g, '').length === 0;
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
  return stripped.replace(/[.,;!?\s]+/g, '').length === 0;
}
