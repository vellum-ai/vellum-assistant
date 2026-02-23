export interface ComputerUseTargetAppHint {
  appName: string;
  bundleId?: string;
}

/**
 * Resolve an explicit target app hint from user task text.
 * This is intentionally conservative: only high-confidence patterns should
 * lock the CU session to an app.
 */
export function resolveComputerUseTargetAppHint(task: string): ComputerUseTargetAppHint | undefined {
  const normalized = task.toLowerCase();

  // "Vellum app"/"Velly app"/"Vellum assistant" should target the desktop app,
  // not similarly named Slack workspaces or Notion pages.
  const vellumDesktopMentioned =
    /\b(vellum|velly)\s+(desktop\s+)?app\b/.test(normalized)
    || /\b(vellum|velly)\s+assistant\b/.test(normalized);

  if (vellumDesktopMentioned) {
    return {
      appName: 'Vellum Assistant',
      bundleId: 'com.vellum.vellum-assistant',
    };
  }

  return undefined;
}
