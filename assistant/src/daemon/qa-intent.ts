/**
 * Detect whether a user's task text indicates a QA/test workflow.
 * Uses keyword/pattern matching for v1 — can be upgraded to semantic detection later.
 */
export function detectQaIntent(taskText: string): boolean {
  const lower = taskText.toLowerCase().trim();

  // Direct QA/test commands
  if (/^(qa|test|verify|check)\b/.test(lower)) return true;

  // Natural language QA patterns
  const qaPatterns = [
    /\b(run|do|perform|execute)\s+(a\s+)?(qa|test|check|verification)\b/,
    /\b(test|qa|verify|check)\s+(this|the|that|my)\b/,
    /\bhelp\s+me\s+(test|qa|verify|check)\b/,
    /\b(can you|could you|please)\s+(test|qa|verify|check)\b/,
    /\btesting\s+(the|this|that|my)\b/,
  ];

  return qaPatterns.some(p => p.test(lower));
}
