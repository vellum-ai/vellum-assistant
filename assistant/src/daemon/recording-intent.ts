/**
 * Detect whether the user is requesting screen recording.
 * This is independent of QA intent — a prompt can trigger both.
 */
const recordingPatterns = [
  /\brecord\s+((my|the|a)\s+)?(screen|display|desktop|session)\b/,
  /\bscreen\s*record/,
  /\bscreen\s+capture\b/,
  /\bcapture\s+((my|the|a)\s+)?(screen|display|desktop)\b/,
  /\bcapture\s+(this|it)\s+(workflow|flow|session|screen|display|desktop|while|as)\b/,
  /\brecord\s+(this|while|what|me)\b/,
  /\bstart\s+recording\b/,
  /\brecord\s+(a\s+)?video\b/,
  /\btake\s+(a\s+)?video\b/,
  /\bvideo\s+record/,
  /\bfilm\s+(this|it|my\s+screen|the\s+screen|screen)\b/,
  /\bmake\s+a\s+recording\b/,
  /\btake\s+a\s+(screen\s+)?recording\b/,
];

export function detectRecordingIntent(taskText: string): boolean {
  const lower = taskText.toLowerCase().trim();
  return recordingPatterns.some(p => p.test(lower));
}

/**
 * Strip recording-related phrasing from the task text so the CU agent
 * focuses on the actual workflow instead of trying to start recording itself.
 * Returns the cleaned text, or a fallback if nothing meaningful remains.
 */
export function stripRecordingIntent(taskText: string): string {
  // Patterns that match recording clauses including surrounding connectors
  const stripPatterns = [
    /\b(please\s+)?record\s+((my|the|a)\s+)?(screen|display|desktop|session)\s*(as\s+I|while\s+I|and\s+)?\s*/gi,
    /\b(please\s+)?screen\s*record\s*(this|while|as|and)?\s*/gi,
    /\b(please\s+)?screen\s+capture\s*(this|while|as|and)?\s*/gi,
    /\b(please\s+)?capture\s+((my|the|a)\s+)?(screen|display|desktop)\s*(as\s+I|while\s+I|and\s+)?\s*/gi,
    /\b(please\s+)?capture\s+(this|it)\s*(as\s+I|while\s+I|and\s+)?\s*/gi,
    /\b(please\s+)?start\s+recording\s*(and\s+|while\s+|as\s+)?\s*/gi,
    /\b(please\s+)?record\s+(a\s+)?video\s+(of\s+)?(this|while|as|and)?\s*/gi,
    /\b(please\s+)?take\s+(a\s+)?video\s+(of\s+)?(this|while|as|and)?\s*/gi,
    /\b(please\s+)?video\s+record\s*(this|while|as|and)?\s*/gi,
    /\b(please\s+)?film\s+(this|it|my\s+screen|the\s+screen|screen)\s*(while|as|and)?\s*/gi,
    /\b(please\s+)?make\s+a\s+recording\s*(of\s+)?(this|while|as|and)?\s*/gi,
    /\b(please\s+)?take\s+a\s+(screen\s+)?recording\s*(of\s+)?(this|while|as|and)?\s*/gi,
    /\b(please\s+)?record\s+(this|while|what|me)\s*/gi,
  ];
  let cleaned = taskText;
  for (const p of stripPatterns) {
    cleaned = cleaned.replace(p, '');
  }
  // Remove connector prefixes left behind by stripped recording clauses.
  cleaned = cleaned.replace(/^\s*(while|as|and|then|to)\s+/i, '');
  cleaned = cleaned.replace(/^[\s,.\-—:]+/, '').replace(/[\s,.\-—:]+$/, '').trim();
  return cleaned || 'Perform the task shown on screen.';
}
