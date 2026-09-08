/**
 * Record that an assistant finished first-run onboarding, on both targets:
 * the device record (every hosting mode) and the lockfile entry when there is
 * one, so the CLI and tray see it too.
 *
 * Separate from `onboarded-assistant-record.ts` because that module is on the
 * resolved-assistants store's read path and must stay free of the lockfile
 * transport.
 */

import { markAssistantOnboarded } from "@/domains/onboarding/onboarded-assistant-record";

/** No-ops on a null id: a dead hatch has nothing to record. */
export function stampAssistantOnboarded(
  assistantId: string | null | undefined,
): void {
  if (!assistantId) {
    return;
  }
  const at = new Date().toISOString();
  markAssistantOnboarded(assistantId, at);
  // The device record is the one that must not fail. The lockfile mirror is
  // best-effort and its transport is Electron-only, so it is loaded on demand
  // rather than dragged into the static graph of the two onboarding screens
  // that call this. Failure is a warning, matching `local-platform-identity`.
  void import("@/lib/local-mode")
    .then((m) => m.markLockfileAssistantOnboarded(assistantId, at))
    .catch((err: unknown) => {
      console.warn("Failed to stamp onboardedAt on the lockfile entry", err);
    });
}
