/**
 * The one place that decides whether an activation surface shows, and which.
 *
 * Every gate lives here rather than in the components so the modal, the pill
 * and the celebration can never disagree about whether the feature is on, and
 * so a new gate is added in exactly one file.
 *
 * The order is deliberate. Cheap local answers come first (flag arm, daemon
 * support), then the server read, then the surfaces this one must not fight
 * with: onboarding routes and the in-chat tour own the screen while they run,
 * and a banner already occupies the slot the pill would take.
 */

import { useLocation } from "react-router";

import {
  resolveActivationListId,
  useActivationChecklistArm,
} from "@/hooks/use-activation-checklist-flag";
import { useSupportsActivationProgress } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useBannerVisible } from "@/stores/banner-visibility-store";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

import { getActivationListIds } from "../catalog";
import {
  useActivationProgress,
  type ActivationProgress,
} from "./use-activation-progress";

/**
 * Which surface to render:
 *
 * - `modal`: the welcome modal, until "Do it Later" is clicked.
 * - `pill`: the top-bar reminder, after dismissal and while starters remain.
 * - `all-done`: the celebration, once and only once.
 * - `null`: nothing, which is also every gated-off state.
 */
export type ActivationSurface = "modal" | "pill" | "all-done";

export interface ActivationVisibility {
  surface: ActivationSurface | null;
  /**
   * The list the surfaces render, frozen by the daemon on the first write and
   * otherwise chosen by the flag arm. `null` whenever `surface` is `null`.
   */
  listId: string | null;
}

const HIDDEN: ActivationVisibility = { surface: null, listId: null };

/** Onboarding owns the whole screen; nothing else may draw over it. */
function isOnboardingRoute(pathname: string): boolean {
  return Object.values(routes.onboarding).some((route) =>
    pathname.startsWith(route),
  );
}

/** How many of a list's three starters the daemon has marked done. */
export function doneStarterCount(
  progress: ActivationProgress,
  listId: string,
): number {
  return getActivationListIds(listId).starters.filter(
    (taskId) => progress.tasks[taskId]?.status === "done",
  ).length;
}

export function useActivationVisibility(): ActivationVisibility {
  const arm = useActivationChecklistArm();
  const armListId = resolveActivationListId(arm);
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const supported = useSupportsActivationProgress(assistantId);
  const { data: progress } = useActivationProgress();
  const { pathname } = useLocation();
  const tourActive = useInChatOnboardingStore.use.prototypeActive();
  const bannerVisible = useBannerVisible();

  if (armListId === null || !supported || !progress) {
    return HIDDEN;
  }
  // The daemon's frozen list wins over the arm, so a re-bucketed user keeps
  // the checklist they already started.
  const listId = progress.listId ?? armListId;
  if (isOnboardingRoute(pathname) || tourActive || bannerVisible) {
    return HIDDEN;
  }

  const starters = getActivationListIds(listId).starters;
  // A frozen list this build's catalog no longer carries has nothing to show
  // and no starters to count as done.
  if (starters.length === 0) {
    return HIDDEN;
  }
  const doneCount = doneStarterCount(progress, listId);

  if (doneCount >= starters.length && progress.allDoneShownAt === null) {
    return { surface: "all-done", listId };
  }
  if (progress.modalDismissedAt === null) {
    return { surface: "modal", listId };
  }
  if (doneCount < starters.length) {
    return { surface: "pill", listId };
  }
  return HIDDEN;
}
