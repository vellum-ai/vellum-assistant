/**
 * Shared seam for the `activation-checklist` string feature flag, which gates
 * the post-onboarding welcome modal, the suggestions pill and the inspiration
 * list.
 *
 * The arm doubles as the content selector: `"off"` hides every surface, and
 * each remaining arm names the task list to show. Percentages per arm live in
 * LaunchDarkly, so a new list ships as a new arm rather than a second flag.
 * An arm the client does not know (a list added to LaunchDarkly ahead of the
 * build reading it) still shows the surface, falling back to `"smb"` rather
 * than hiding a feature the user has been targeted into.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

export const ACTIVATION_LIST_IDS = ["smb", "parent", "general"] as const;

export type ActivationListId = (typeof ACTIVATION_LIST_IDS)[number];

/** Current `activation-checklist` arm; "off" until flags hydrate. */
export function useActivationChecklistArm(): string {
  return (
    useClientFeatureFlagStore.use.stringFlags().activationChecklist ?? "off"
  );
}

/**
 * Non-hook variant of {@link useActivationChecklistArm}, for the readers that
 * run outside a render: telemetry tags every event with the arm and is called
 * from event handlers and effects.
 */
export function readActivationChecklistArm(): string {
  return (
    useClientFeatureFlagStore.getState().stringFlags.activationChecklist ??
    "off"
  );
}

/** The task list an arm selects, or null when the surface is off. */
export function resolveActivationListId(arm: string): ActivationListId | null {
  if (arm === "off" || arm === "") {
    return null;
  }
  return ACTIVATION_LIST_IDS.find((listId) => listId === arm) ?? "smb";
}
