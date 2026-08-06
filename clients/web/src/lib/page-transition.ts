/**
 * Directional page transitions for the native mobile shells, driven by the
 * View Transitions API.
 *
 * A router navigation is asynchronous: middleware runs, lazy chunks resolve,
 * and React renders the new subtree before anything can paint. Animating
 * around that by hand means hiding the outgoing page first and exposing the
 * whole wait as an empty screen. `document.startViewTransition` inverts it —
 * React Router calls it at the *commit* point, and the browser holds a
 * snapshot of the outgoing page until the incoming one has rendered, so the
 * wait is covered rather than displayed.
 *
 * The motion itself is CSS: `::view-transition-old(root)` and
 * `::view-transition-new(root)` in `index.css`, keyed off the
 * `data-page-transition` attribute this module writes. Both snapshots exist at
 * once, so the two pages move together rather than one after the other.
 *
 * Degrades silently. Off the mobile shells, and on any engine without the API
 * (it needs iOS 18), the navigation runs exactly as it does today: React
 * Router checks for `startViewTransition` itself and falls back to a plain
 * state update.
 */

import type { NavigateFunction, NavigateOptions, To } from "react-router";

import { EDGE_SWIPE_SLIDE_MS } from "@/hooks/edge-swipe-motion";
import { isNativeMobile } from "@/runtime/platform-detection";

/**
 * Which way the pages travel. `push` moves deeper into a section (the new page
 * arrives from the trailing edge); `pop` returns toward the root.
 */
export type PageTransitionDirection = "push" | "pop";

/** Read by the `::view-transition-*` rules in `index.css`. */
const DIRECTION_ATTRIBUTE = "data-page-transition";

/**
 * How long the attribute outlives the navigation. Only the pseudo-elements
 * read it and they exist only mid-transition, so a stale value is inert; the
 * cleanup keeps the DOM honest rather than guarding anything.
 */
const ATTRIBUTE_CLEANUP_MS = EDGE_SWIPE_SLIDE_MS * 2;

let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

function supportsViewTransitions(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.startViewTransition === "function"
  );
}

/** Whether a navigation from here would animate, for callers that need to know. */
export function pageTransitionsEnabled(): boolean {
  return isNativeMobile() && supportsViewTransitions();
}

/**
 * Navigate with a directional slide where the platform supports one, and
 * exactly like `navigate()` everywhere else.
 *
 * `viewTransition` is per-navigation rather than global so a route change that
 * should not animate (a redirect, a same-page param update) simply omits it.
 */
export function navigateWithPageTransition(
  navigate: NavigateFunction,
  to: To,
  direction: PageTransitionDirection,
  options?: NavigateOptions,
): void {
  if (!pageTransitionsEnabled()) {
    void navigate(to, options);
    return;
  }

  document.documentElement.setAttribute(DIRECTION_ATTRIBUTE, direction);
  if (cleanupTimer !== undefined) {
    clearTimeout(cleanupTimer);
  }
  cleanupTimer = setTimeout(() => {
    cleanupTimer = undefined;
    document.documentElement.removeAttribute(DIRECTION_ATTRIBUTE);
  }, ATTRIBUTE_CLEANUP_MS);

  void navigate(to, { ...options, viewTransition: true });
}

/** @internal Exposed for test isolation only. */
export function resetPageTransitionState(): void {
  if (cleanupTimer !== undefined) {
    clearTimeout(cleanupTimer);
    cleanupTimer = undefined;
  }
  document.documentElement.removeAttribute(DIRECTION_ATTRIBUTE);
}
