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
 * Lives beside `use-activation-checklist-flag` in the shared hooks directory
 * rather than in the activation domain because the Preferences menu is a chat
 * component: this is the seam it already reaches activation through, and a
 * domain-to-domain import is what `docs/CONVENTIONS.md` forbids.
 */

import {
  resolveActivationListId,
  useActivationChecklistArm,
  type ActivationListId,
} from "@/hooks/use-activation-checklist-flag";
import { useSupportsActivationProgress } from "@/lib/backwards-compat/use-supports-activation-progress";

/**
 * The list activation is enabled for on `assistantId`, or `null` when either
 * gate fails. `null` while the assistant's version is unknown, which keeps the
 * feature hidden until identity resolves rather than offering launches the
 * daemon cannot link.
 */
export function useActivationEnabledListId(
  assistantId: string | null | undefined,
): ActivationListId | null {
  const arm = useActivationChecklistArm();
  const supported = useSupportsActivationProgress(assistantId);
  return supported ? resolveActivationListId(arm) : null;
}
