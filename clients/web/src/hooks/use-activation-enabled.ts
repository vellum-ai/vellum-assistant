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
import { useAssistantIdentitySettledFor } from "@/lib/backwards-compat/utils";
import { useSupportsActivationProgress } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * What one of the two gates has to say.
 *
 * Both start on an input that reads exactly like "off": the flag store answers
 * the registry default until the first server response, and the version gate
 * answers `false` until identity lands for this assistant. Collapsing that into
 * a boolean is what a surface that only hides wants and what a surface that
 * navigates cannot use, so the third value is kept: `"unknown"` is a gate that
 * has not spoken, and only `"disabled"` is a no.
 */
type ActivationGate = "unknown" | "enabled" | "disabled";

/** The flag arm's gate. `"unknown"` until the first server response lands. */
function useActivationArmGate(): ActivationGate {
  const flagsHydrated = useClientFeatureFlagStore.use.hydrated();
  const arm = useActivationChecklistArm();
  if (!flagsHydrated) {
    return "unknown";
  }
  return resolveActivationListId(arm) === null ? "disabled" : "enabled";
}

/**
 * The daemon's gate: whether this assistant carries the `/v1/activation/*`
 * routes every surface reads and writes.
 *
 * `"unknown"` only while the identity fetch is still in flight. A fetch that
 * finished with nothing is a `"disabled"` answer, not a wait that never ends:
 * an assistant whose version we will never learn cannot be shown launches the
 * daemon may not be able to link.
 */
function useActivationVersionGate(
  assistantId: string | null | undefined,
): ActivationGate {
  const supported = useSupportsActivationProgress(assistantId);
  const identitySettled = useAssistantIdentitySettledFor(assistantId);
  if (supported) {
    return "enabled";
  }
  return identitySettled ? "disabled" : "unknown";
}

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
  const versionGate = useActivationVersionGate(assistantId);
  return versionGate === "enabled" ? resolveActivationListId(arm) : null;
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
 * A surface that only hides is right to treat an unspoken gate as off and let
 * the answer arrive. A surface that navigates is not: the Inspiration List is
 * reachable by a bookmark, a reload and a fresh tab, and a redirect fired on
 * the unsettled answer takes the user to chat before either gate has spoken.
 * Such a caller waits on this.
 *
 * Disabled wins outright. A gate that has said no has settled the question,
 * and holding the page blank for a second opinion the answer cannot change is
 * how an arm switched off, or an identity fetch that never lands, turns a
 * bookmark into a page that renders nothing at all.
 */
export function useActivationGatesSettled(
  assistantId: string | null | undefined,
): boolean {
  const armGate = useActivationArmGate();
  const versionGate = useActivationVersionGate(assistantId);
  if (armGate === "disabled" || versionGate === "disabled") {
    return true;
  }
  return armGate !== "unknown" && versionGate !== "unknown";
}
