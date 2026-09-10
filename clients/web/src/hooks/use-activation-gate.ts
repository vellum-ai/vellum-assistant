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
 * A leaf on purpose: nothing here reads the daemon's progress. The progress
 * query is itself gated on these two answers, so a gate that consulted it
 * would close the loop and neither could be the single definition.
 * `use-activation-enabled.ts` is the layer above, where the frozen list the
 * progress document carries overrides the arm's.
 *
 * The active assistant is read here rather than passed in. Every caller was
 * reaching for the same `activeAssistantId`, and a parameter only offered them
 * the chance to disagree.
 */

import {
  resolveActivationListId,
  useActivationChecklistArm,
  type ActivationListId,
} from "@/hooks/use-activation-checklist-flag";
import { useSupportsActivationProgress } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useAssistantIdentitySettledFor } from "@/lib/backwards-compat/utils";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * The list the arm selects, or `null` when either gate fails. `null` while the
 * assistant's version is unknown too, which keeps the feature hidden until
 * identity resolves rather than offering launches the daemon cannot link.
 */
export function useActivationEnabledListId(): ActivationListId | null {
  const arm = useActivationChecklistArm();
  const supported = useSupportsActivationProgress();
  return supported ? resolveActivationListId(arm) : null;
}

/**
 * Whether the gates above can answer yet.
 *
 * A surface that only hides is right to treat an unspoken gate as off and let
 * the answer arrive. A surface that navigates is not: the Inspiration List is
 * reachable by a bookmark, a reload and a fresh tab, and a redirect fired on
 * the unsettled answer takes the user to chat before either gate has spoken.
 * Such a caller waits on this.
 *
 * Both gates start on an input that reads exactly like "off": the flag store
 * answers the registry default until the first server response, and the
 * version gate answers `false` until identity lands for this assistant.
 *
 * Disabled wins outright. A gate that has said no has settled the question,
 * and holding the page blank for a second opinion the answer cannot change is
 * how an arm switched off, or an identity fetch that never lands, turns a
 * bookmark into a page that renders nothing at all. An identity fetch that
 * finished with nothing counts as settled for the same reason: an assistant
 * whose version we will never learn cannot be shown launches the daemon may
 * not be able to link.
 */
export function useActivationGatesSettled(): boolean {
  const flagsHydrated = useClientFeatureFlagStore.use.hydrated();
  const arm = useActivationChecklistArm();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const supported = useSupportsActivationProgress();
  const identitySettled = useAssistantIdentitySettledFor(assistantId);

  const armDisabled = flagsHydrated && resolveActivationListId(arm) === null;
  const versionSettled = supported || identitySettled;
  const versionDisabled = !supported && identitySettled;
  return armDisabled || versionDisabled || (flagsHydrated && versionSettled);
}
