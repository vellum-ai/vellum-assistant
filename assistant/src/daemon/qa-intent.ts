/**
 * Detect whether a user's task text indicates a QA/test workflow.
 * Uses keyword/pattern matching for v1 — can be upgraded to semantic detection later.
 */
export function detectQaIntent(taskText: string): boolean {
  const lower = taskText.toLowerCase().trim();

  // Direct QA/test commands — "check" excluded because it's too common
  // in everyday tasks ("check my email", "check the weather").
  if (/^(qa|test|verify)\b/.test(lower)) return true;

  // Natural language QA patterns — intentionally narrow to avoid false positives.
  const qaPatterns = [
    /\b(run|do|perform|execute)\s+(a\s+)?(qa|test|verification)\b/,
    /\b(test|qa|verify)\s+(this|the|that|my)\b/,
    /\bhelp\s+me\s+(test|qa|verify)\b/,
    /\b(can you|could you|please)\s+(test|qa|verify)\b/,
    /\btesting\s+(the|this|that|my)\b/,
    /\bcheck\s+for\s+(bugs|errors|issues|regressions)\b/,
  ];

  return qaPatterns.some(p => p.test(lower));
}
