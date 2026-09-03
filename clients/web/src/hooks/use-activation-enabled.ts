/**
 * The two gates every activation surface shares: an arm that names a list, and
 * a daemon carrying the `/v1/activation/*` routes the surfaces read and write.
 *
 * One definition, so the welcome modal, the pill, the Inspiration List page and
 * the Preferences entry that opens it can never disagree about whether the
 * feature is on. A surface that adds a gate of its own (a route the pill must
 * not draw over, a progress read that has not landed) layers it on top of this
 * one rather than restating these two.
 *
 * The same file answers which list, since every caller of the gate needs one:
 * the arm names it and the daemon's freeze overrides it.
 *
 * Lives beside `use-activation-checklist-flag` in the shared hooks directory
 * rather than in the activation domain because the Preferences menu is a chat
 * component: this is the seam it already reaches activation through, and a
 * domain-to-domain import is what `docs/CONVENTIONS.md` forbids.
 */

import { useActivationProgress } from "@/domains/activation/hooks/use-activation-progress";
import {
  ACTIVATION_LIST_IDS,
  resolveActivationListId,
  useActivationChecklistArm,
  type ActivationListId,
} from "@/hooks/use-activation-checklist-flag";
import { useAssistantVersionKnownFor } from "@/lib/backwards-compat/utils";
import { useSupportsActivationProgress } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * The list the arm selects on `assistantId`, or `null` when either gate fails.
 * `null` while the assistant's version is unknown, which keeps the feature
 * hidden until identity resolves rather than offering launches the daemon
 * cannot link.
 */
function useActivationEnabledListId(
  assistantId: string | null | undefined,
): ActivationListId | null {
  const arm = useActivationChecklistArm();
  const supported = useSupportsActivationProgress(assistantId);
  return supported ? resolveActivationListId(arm) : null;
}

/**
 * The list the user is actually on: the one the daemon froze on the first
 * write, falling back to the arm's while nothing is frozen.
 *
 * Every surface that names a list reads it from here, so the route, the
 * visibility hook and the funnel events a re-bucketed user produces can never
 * name different lists. `null` whenever the gates are off, which the freeze
 * cannot override: a frozen list says which checklist, never whether.
 */
function isActivationListId(value: string): value is ActivationListId {
  return (ACTIVATION_LIST_IDS as readonly string[]).includes(value);
}

export function useEffectiveActivationListId(
  assistantId: string | null | undefined,
): string | null {
  const armListId = useActivationEnabledListId(assistantId);
  const { data: progress } = useActivationProgress();
  if (armListId === null) {
    return null;
  }
  const frozen = progress?.listId;
  if (frozen === null || frozen === undefined) {
    return armListId;
  }
  // A frozen id this bundle has no catalog for (written by a newer client)
  // hides the surfaces rather than enabling an empty list.
  return isActivationListId(frozen) ? frozen : null;
}

/**
 * Whether the gates above can answer yet.
 *
 * Both of their inputs start on a value that reads exactly like "off": the flag
 * store answers the registry default until the first server response, and the
 * version gate answers `false` until identity lands for this assistant. A
 * surface that only hides is right to treat that as off and let the answer
 * arrive. A surface that navigates is not: the Inspiration List is reachable by
 * a bookmark, a reload and a fresh tab, and a redirect fired on the unsettled
 * answer takes the user to chat before either gate has spoken.
 */
export function useActivationGatesSettled(
  assistantId: string | null | undefined,
): boolean {
  const flagsHydrated = useClientFeatureFlagStore.use.hydrated();
  const versionKnown = useAssistantVersionKnownFor(assistantId);
  return flagsHydrated && versionKnown;
}
