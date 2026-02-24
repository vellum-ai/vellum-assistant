/**
 * Detect whether the user is requesting screen recording.
 * This is independent of QA intent — a prompt can trigger both.
 * The caller (misc.ts) merges recording intent with QA-based recording
 * via the `requiresRecording` computation, so no dedup is needed here.
 */
export function detectRecordingIntent(taskText: string): boolean {
  const lower = taskText.toLowerCase().trim();

  const recordingPatterns = [
    /\brecord\s+((my|the|a)\s+)?(screen|display|desktop|session)\b/,
    /\bscreen\s*record/,
    /\bcapture\s+((my|the|a)\s+)?(screen|display|desktop)\b/,
    /\brecord\s+(this|while|what|me)\b/,
    /\bstart\s+recording\b/,
    /\brecord\s+(a\s+)?video\b/,
    /\bvideo\s+record/,
    /\bmake\s+a\s+recording\b/,
    /\btake\s+a\s+(screen\s+)?recording\b/,
  ];

  return recordingPatterns.some(p => p.test(lower));
}
