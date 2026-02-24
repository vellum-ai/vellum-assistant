/**
 * Detect whether the user is explicitly opting out of QA/recording mode.
 * Used to clear the thread-level QA latch.
 */
export function detectQaOptOut(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const optOutPatterns = [
    /\bstop\s+qa\s+mode\b/,
    /\bno\s+recording\b/,
    /\bdisable\s+recording\b/,
    /\bstop\s+testing\b/,
    /\bstop\s+recording\b/,
    /\bturn\s+off\s+qa\b/,
    /\bturn\s+off\s+recording\b/,
    /\bend\s+qa\s+mode\b/,
    /\bexit\s+qa\s+mode\b/,
    /\bquit\s+qa\s+mode\b/,
  ];
  return optOutPatterns.some(p => p.test(lower));
}

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
    /\b(i want to|let'?s)\s+(qa|test|verify)\b/,
    /\bhelp\s+me\s+(test|qa|verify)\b/,
    /\b(can you|could you|please)\s+(test|qa|verify)\b/,
    /\btesting\s+(the|this|that|my)\b/,
    /\bcheck\s+for\s+(bugs|errors|issues|regressions)\b/,
  ];

  return qaPatterns.some(p => p.test(lower));
}

/**
 * Whether a QA/test request should be routed directly to foreground computer use.
 * This is used to avoid classifier drift for explicit UI/app QA requests.
 */
export function shouldRouteQaToComputerUse(taskText: string): boolean {
  if (!detectQaIntent(taskText)) return false;

  const lower = taskText.toLowerCase().trim();
  const guiCues = [
    /\bdesktop app\b/,
    /\bapp\b/,
    /\bui\b/,
    /\bscreen\b/,
    /\bwindow\b/,
    /\bcomposer\b/,
    /\bin\s+the\s+thread\b/,
    /\bin\s+the\s+chat\b/,
    /\bbutton\b/,
    /\bclick\b/,
    /\btype\s+(in|into|text)\b/,
    /\btyping\b/,
    /\bscroll\b/,
    /\bnavigate\b/,
    /\bopen\s+(the\s+)?(app|window|dialog|menu|browser)\b/,
    /\bsend\s+(a\s+)?(message|button|form)\b/,
    /\bworkflow\b/,
    /\bbehavior\b/,
  ];
  const codeTestCues = [
    /\bunit tests?\b/,
    /\bintegration tests?\b/,
    /\be2e tests?\b/,
    /\bwrite tests?\b/,
    /\btest file\b/,
    /\bjest\b/,
    /\bvitest\b/,
    /\bpytest\b/,
    /\bmocha\b/,
    /\bcypress\b/,
    /\bplaywright\b/,
    /\bci\b/,
  ];

  const hasGuiCue = guiCues.some((pattern) => pattern.test(lower));
  if (hasGuiCue) return true;

  const hasCodeOnlyCue = codeTestCues.some((pattern) => pattern.test(lower));
  if (hasCodeOnlyCue) return false;

  // No positive GUI cue and no code-only cue — don't force CU routing.
  // Absence of evidence is not evidence of GUI intent; let the classifier decide.
  return false;
}
