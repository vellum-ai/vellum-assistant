/**
 * Whether an existing assistant should skip first-run research onboarding.
 *
 * There is no durable "research completed" flag. Hatch age is the stored
 * proxy: an assistant created at least a week ago has almost certainly
 * finished onboarding, so login, signup, and the privacy screen should not
 * send that user through `/onboarding/research` again.
 */

export const ONBOARDED_HATCH_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function isHatchedOnboarded(
  hatchedAt: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!hatchedAt) {
    return false;
  }
  const hatchedMs = Date.parse(hatchedAt);
  if (Number.isNaN(hatchedMs)) {
    return false;
  }
  return nowMs - hatchedMs >= ONBOARDED_HATCH_AGE_MS;
}

export function hasOnboardedAssistant(
  assistants: ReadonlyArray<{ hatchedAt?: string }>,
  nowMs: number = Date.now(),
): boolean {
  return assistants.some((assistant) =>
    isHatchedOnboarded(assistant.hatchedAt, nowMs),
  );
}
