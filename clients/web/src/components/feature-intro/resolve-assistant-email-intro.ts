import type { InboxStatus } from "@/domains/assistant-inbox/resolve-inbox-status";

export interface AssistantEmailIntroInputs {
  /** The intro was dismissed on this device. */
  seen: boolean;
  /** The flag store has answered once; before that every flag reads off. */
  flagsHydrated: boolean;
  /** The `assistant-inbox` flag. */
  inboxEnabled: boolean;
  /** The research-onboarding takeover is on screen, or its check-in is. */
  onboardingBusy: boolean;
  status: InboxStatus;
}

/**
 * Which intro to show, if any, from what the app knows: `locked` is the
 * design's pitch for a plan without email, `open` the one for a plan that
 * has it and an assistant with no address yet. Pure so the decision can be
 * tested without the hooks that feed it.
 *
 * Nothing shows while the reads that decide are pending, so a user is never
 * pitched an upgrade their plan already includes; and nothing shows to an
 * assistant that already has an address, since the intro is news and that
 * user has it.
 */
export function resolveAssistantEmailIntro(
  inputs: AssistantEmailIntroInputs,
): "locked" | "open" | null {
  if (inputs.seen || !inputs.flagsHydrated || !inputs.inboxEnabled) {
    return null;
  }
  if (inputs.onboardingBusy) {
    return null;
  }
  switch (inputs.status) {
    case "upgrade":
      return "locked";
    case "setup":
      return "open";
    default:
      return null;
  }
}
