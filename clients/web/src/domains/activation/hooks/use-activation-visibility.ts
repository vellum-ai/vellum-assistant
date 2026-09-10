/**
 * The one place that decides whether an activation surface shows, and which.
 *
 * Every gate lives here rather than in the components so the modal, the pill
 * and the celebration can never disagree about whether the feature is on, and
 * so a new gate is added in exactly one file.
 *
 * The order is deliberate. The cheap local answer comes first
 * (`useEffectiveActivationListId`, which carries the flag arm, the daemon
 * support gate and the daemon's frozen list, the three every activation
 * surface shares), then the server read, then the surfaces this one must not
 * fight with: onboarding routes and the in-chat tour own the screen while they
 * run, and the Inspiration List is already the whole checklist.
 *
 * A banner is the last gate and applies to the pill alone. It occupies the
 * slot the pill would take, which is a reason to drop the pill and no reason
 * at all to drop a blocking dialog: the welcome modal is the surface a
 * first-time user is meant to meet, and hiding it behind any composer nudge
 * would retire the checklist for whoever happens to have one.
 */

import { useLocation } from "react-router";

import type { ActivationListId } from "@/hooks/use-activation-checklist-flag";
import { useEffectiveActivationListId } from "@/hooks/use-activation-enabled";
import { useBannerVisible } from "@/stores/banner-visibility-store";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { routes } from "@/utils/routes";

import { getActivationListIds } from "../catalog";
import {
  activationRowStatus,
  useActivationProgress,
  type ActivationProgress,
} from "./use-activation-progress";

/**
 * Which surface to render:
 *
 * - `modal`: the welcome modal, until "Do it Later" is clicked.
 * - `pill`: the top-bar reminder, after dismissal and while starters remain.
 * - `all-done`: the celebration, once and only once, and the last surface the
 *   checklist ever shows.
 * - `null`: nothing, which is also every gated-off state.
 */
export type ActivationSurface = "modal" | "pill" | "all-done";

export interface ActivationVisibility {
  surface: ActivationSurface | null;
  /**
   * The list the surfaces render, frozen by the daemon on the first write and
   * otherwise chosen by the flag arm. `null` whenever `surface` is `null`.
   */
  listId: ActivationListId | null;
}

const HIDDEN: ActivationVisibility = { surface: null, listId: null };

/** Onboarding owns the whole screen; nothing else may draw over it. */
function isOnboardingRoute(pathname: string): boolean {
  return Object.values(routes.onboarding).some((route) =>
    pathname.startsWith(route),
  );
}

/**
 * The Inspiration List is this checklist, in full and already launchable. A
 * modal over it hides what the user opened, and a pill beside it points at the
 * page they are on.
 *
 * Matched on the segment boundary rather than by prefix, so a sibling route
 * that happens to share the first characters of this one (a
 * `/assistant/suggestions-archive`) keeps the surfaces it is entitled to.
 */
function isActivationListRoute(pathname: string): boolean {
  return (
    pathname === routes.activationList ||
    pathname.startsWith(`${routes.activationList}/`)
  );
}

/** How many of a list's three starters the daemon has marked done. */
export function doneStarterCount(
  progress: ActivationProgress,
  listId: string,
): number {
  return getActivationListIds(listId).starters.filter(
    (taskId) => activationRowStatus(progress.tasks[taskId]) === "done",
  ).length;
}

export function useActivationVisibility(): ActivationVisibility {
  const listId = useEffectiveActivationListId();
  const { data: progress } = useActivationProgress();
  const { pathname } = useLocation();
  const tourActive = useInChatOnboardingStore.use.prototypeActive();
  const bannerVisible = useBannerVisible();

  if (listId === null || !progress) {
    return HIDDEN;
  }
  if (
    isOnboardingRoute(pathname) ||
    isActivationListRoute(pathname) ||
    tourActive
  ) {
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
  // The celebration is terminal. It is only reachable once every starter is
  // done, and closing it records `allDoneShownAt` alone, so a user who
  // finished the list without ever clicking "Do it Later" still carries a null
  // `modalDismissedAt` and would otherwise land back on the welcome modal.
  if (progress.allDoneShownAt !== null) {
    return HIDDEN;
  }
  if (progress.modalDismissedAt === null) {
    return { surface: "modal", listId };
  }
  if (doneCount < starters.length) {
    return bannerVisible ? HIDDEN : { surface: "pill", listId };
  }
  return HIDDEN;
}
