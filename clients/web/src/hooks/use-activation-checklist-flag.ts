/**
 * Shared seam for the `experiment-activation-checklist-2026-09-10` string feature flag, which gates
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

/** Current `experiment-activation-checklist-2026-09-10` arm; "off" until flags hydrate. */
export function useActivationChecklistArm(): string {
  return (
    useClientFeatureFlagStore.use.stringFlags()
      .experimentActivationChecklist20260910 ?? "off"
  );
}

/**
 * Non-hook variant of {@link useActivationChecklistArm}, for the readers that
 * run outside a render: telemetry tags every event with the arm and is called
 * from event handlers and effects.
 */
export function readActivationChecklistArm(): string {
  return (
    useClientFeatureFlagStore.getState().stringFlags
      .experimentActivationChecklist20260910 ?? "off"
  );
}

/**
 * The task list an arm selects, or null when the surface is off.
 *
 * Only a value that names a shipped list turns the surface on. `off` is the
 * control arm, and any value this bundle does not know (a newer arm, or a
 * non-arm fallthrough such as `ineligible`) also reads as off, so a targeting
 * change can never enroll a user in a treatment the client cannot render.
 */
export function resolveActivationListId(arm: string): ActivationListId | null {
  return ACTIVATION_LIST_IDS.find((listId) => listId === arm) ?? null;
}
