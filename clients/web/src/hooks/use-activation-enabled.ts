/**
 * The list the user is actually on: the one the daemon froze on the first
 * write, falling back to the arm's while nothing is frozen.
 *
 * Every surface that names a list reads it from here, so the route, the
 * visibility hook and the funnel events a re-bucketed user produces can never
 * name different lists. `null` whenever the gates in `use-activation-gate.ts`
 * are off, which the freeze cannot override: a frozen list says which
 * checklist, never whether.
 *
 * Lives beside `use-activation-checklist-flag` in the shared hooks directory
 * rather than in the activation domain because the Preferences menu is a chat
 * component: this is the seam it already reaches activation through, and a
 * domain-to-domain import is what `docs/CONVENTIONS.md` forbids. Importing the
 * activation domain from here is the direction that rule allows.
 */

import { useEffect } from "react";

import { useActivationProgress } from "@/domains/activation/hooks/use-activation-progress";
import {
  ACTIVATION_LIST_IDS,
  type ActivationListId,
} from "@/hooks/use-activation-checklist-flag";
import { useActivationEnabledListId } from "@/hooks/use-activation-gate";

function isActivationListId(value: string): value is ActivationListId {
  return (ACTIVATION_LIST_IDS as readonly string[]).includes(value);
}

/**
 * The last list the hook below resolved.
 *
 * Telemetry qualifies every activation event with the list, and it is called
 * from event handlers and effects rather than from a render, so it cannot ask
 * a hook. The frozen half of the answer lives in the React Query cache, which
 * has no handle outside a provider, so the hook that already computes it
 * publishes the result here instead.
 */
let effectiveListId: ActivationListId | null = null;

/** {@link useEffectiveActivationListId} as of the last render that ran it. */
export function readEffectiveActivationListId(): ActivationListId | null {
  return effectiveListId;
}

function resolveEffectiveListId(
  armListId: ActivationListId | null,
  frozen: string | null | undefined,
): ActivationListId | null {
  if (armListId === null) {
    return null;
  }
  if (frozen === null || frozen === undefined) {
    return armListId;
  }
  // A frozen id this bundle has no catalog for (written by a newer client)
  // hides the surfaces rather than enabling an empty list.
  return isActivationListId(frozen) ? frozen : null;
}

export function useEffectiveActivationListId(): ActivationListId | null {
  const armListId = useActivationEnabledListId();
  const { data: progress } = useActivationProgress();
  const listId = resolveEffectiveListId(armListId, progress?.listId);
  useEffect(() => {
    effectiveListId = listId;
  }, [listId]);
  return listId;
}
