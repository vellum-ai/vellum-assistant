/**
 * Whether an assistant is past first-run research onboarding.
 *
 * The stamp written where the funnel terminates is the real signal. It lives
 * in two places: on the lockfile entry (local mode, visible to the CLI and
 * tray) and in a device-scoped record that also covers cloud and browser
 * clients. The device half is read live rather than cached on the assistant
 * row, so a completion in this tab or another one takes effect immediately
 * instead of waiting for the next assistant-list refresh.
 *
 * Hatch age is the legacy fallback for assistants that predate the stamp: one
 * created at least a week ago has almost certainly finished, so an upgrade
 * does not re-funnel anybody.
 *
 * Ask the right question. `userHasOnboardedAssistant` answers "is this a
 * returning user" and belongs on post-auth and intercept decisions;
 * `isSelectedAssistantOnboarded` answers "is THIS assistant past first run"
 * and belongs on the privacy funnel. Using the first for the second is what
 * made one week-old assistant bounce every new-assistant walk (#41656).
 */

import { readOnboardedAt } from "@/domains/onboarding/onboarded-assistant-record";

/** Legacy proxy window, used only when the stamp is absent. */
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

interface OnboardingSignals {
  id: string;
  /** The lockfile half of the stamp; the device half is read here. */
  onboardedAt?: string;
  hatchedAt?: string;
}

/** A stamped assistant is onboarded; an unstamped one falls back to hatch age. */
export function isAssistantOnboarded(
  assistant: OnboardingSignals,
  nowMs: number = Date.now(),
): boolean {
  if (assistant.onboardedAt ?? readOnboardedAt(assistant.id)) {
    return true;
  }
  return isHatchedOnboarded(assistant.hatchedAt, nowMs);
}

/**
 * Does the user own any onboarded assistant? The right question for post-auth
 * and the onboarding intercept, where the landing assistant is not yet known.
 */
export function userHasOnboardedAssistant(
  assistants: ReadonlyArray<OnboardingSignals>,
  nowMs: number = Date.now(),
): boolean {
  return assistants.some((assistant) => isAssistantOnboarded(assistant, nowMs));
}

/**
 * Is the assistant the user currently has selected onboarded? False when
 * nothing is selected or the id is not in the list: an unidentifiable
 * assistant must not be assumed past first run, or the funnel bounces walks
 * that legitimately need to run.
 */
export function isSelectedAssistantOnboarded(
  assistants: ReadonlyArray<OnboardingSignals>,
  selectedAssistantId: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (!selectedAssistantId) {
    return false;
  }
  const selected = assistants.find((a) => a.id === selectedAssistantId);
  return selected ? isAssistantOnboarded(selected, nowMs) : false;
}
