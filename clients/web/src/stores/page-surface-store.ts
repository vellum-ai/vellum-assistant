/**
 * The canvas color the active route wants behind the whole app shell.
 *
 * On the native mobile shells the safe-area strips are padding on
 * `root-layout`'s `.app-shell`, so they show that element's own background,
 * `--surface-base`. A page whose content sits on a themed surface therefore
 * reads as a themed card floating on a neutral canvas, with the status bar and
 * the home indicator visibly not part of the page.
 *
 * A route publishes its surface here and the shell paints it, which is the only
 * element that owns both the insets and the paint. The page decides, the shell
 * applies, and nothing between them has to know about either.
 *
 * Consumed only under `isNativeMobile()`: desktop web and Electron keep the
 * neutral canvas that makes `PageShell`'s card read as a card.
 *
 * Publishers register through {@link usePublishPageSurface} and clear on
 * unmount, the same convention as the header slots in `chat-layout-slots-store`.
 */

import { useId, useLayoutEffect, useRef } from "react";
import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface PageSurfaceState {
  /**
   * A CSS color value (usually a `var(--surface-*)` reference), or null to fall
   * back to the shell's neutral canvas.
   */
  surface: string | null;
  /**
   * Which publisher {@link surface} belongs to, so an outgoing one can tell
   * whether it is still the owner before clearing. Identity rather than color:
   * two screens overlapping on the same color are indistinguishable by value,
   * and the outgoing one would clear a surface the incoming one is still
   * showing. Not read by the shell.
   */
  owner: string | null;
  /**
   * How the strips should get to {@link surface}: the tail of a CSS
   * `transition` shorthand (duration, easing, and optional delay), or null to
   * change it in one frame.
   *
   * A page whose canvas animates has to say so, because the strips are painted
   * by a different element than the page: publishing only the destination color
   * snaps them there while the canvas is still crossfading, which is the same
   * visible seam along the edge that publishing a surface at all is meant to
   * remove. Mirror the page's own motion transition here.
   *
   * Applies to a publisher's changes of color, never to its first: see
   * {@link usePublishPageSurface}.
   */
  transition: string | null;
}

interface PageSurfaceActions {
  setSurface: (
    surface: string | null,
    transition?: string | null,
    owner?: string | null,
  ) => void;
}

const usePageSurfaceStoreBase = create<PageSurfaceState & PageSurfaceActions>(
  (set) => ({
    surface: null,
    transition: null,
    owner: null,
    setSurface: (surface, transition = null, owner = null) =>
      set((state) =>
        state.surface === surface &&
        state.transition === transition &&
        state.owner === owner
          ? state
          : { surface, transition, owner },
      ),
  }),
);

export const usePageSurfaceStore = createSelectors(usePageSurfaceStoreBase);

/** The neutral canvas every non-publishing surface keeps. */
export const DEFAULT_SHELL_BACKGROUND = "var(--surface-base)";

/**
 * The app shell's background for a published page surface.
 *
 * Split out from the shell so the platform gate is directly testable: desktop
 * web and Electron must keep {@link DEFAULT_SHELL_BACKGROUND} no matter what a
 * page publishes.
 */
export function resolveShellBackground(
  pageSurface: string | null,
  nativeMobile: boolean,
): string {
  return pageSurface && nativeMobile ? pageSurface : DEFAULT_SHELL_BACKGROUND;
}

/**
 * The app shell's `transition` for a published surface, scoped to the color so
 * it never catches the height and padding the shell re-computes for the iOS
 * keyboard. `undefined` (not `"none"`) when nothing is animating, so the shell
 * leaves the property off entirely.
 */
export function resolveShellTransition(
  pageTransition: string | null,
  nativeMobile: boolean,
): string | undefined {
  return pageTransition && nativeMobile
    ? `background-color ${pageTransition}`
    : undefined;
}

/**
 * Motion's named easings, in the CSS spelling of the same curves. Motion's
 * `easeInOut` is `cubic-bezier(0.42, 0, 0.58, 1)` and CSS's `ease-in-out` is
 * the same, and so on down the list, so a fade stated in one form runs on the
 * identical curve in the other.
 */
const CSS_EASING = {
  linear: "linear",
  easeIn: "ease-in",
  easeOut: "ease-out",
  easeInOut: "ease-in-out",
} as const;

/**
 * A page's own fade, in the subset of Motion's transition that has a CSS
 * equivalent. Omitting `ease` means Motion's default for a tween, `easeOut`.
 */
export interface PageSurfaceFade {
  duration: number;
  delay?: number;
  ease?: keyof typeof CSS_EASING;
}

/**
 * The CSS form of a page's Motion fade, for {@link usePublishPageSurface}.
 *
 * The strips are painted by the shell and the canvas by the page, so the same
 * fade has to be expressed twice, once for each engine. Deriving the second
 * from the first is what keeps them equal: stated separately they are two
 * literals whose agreement nothing enforces, and the seam this whole mechanism
 * exists to remove comes back the moment one is edited alone.
 */
export function cssTransitionFor({
  duration,
  delay = 0,
  ease = "easeOut",
}: PageSurfaceFade): string {
  const timing = `${duration}s ${CSS_EASING[ease]}`;
  return delay > 0 ? `${timing} ${delay}s` : timing;
}

/**
 * Publish `surface` as the shell canvas for as long as the caller is mounted,
 * reaching it over `transition` when the page's own canvas animates there.
 *
 * `transition` applies to this caller's changes of color, never to its first
 * publish, which always lands outright.
 *
 * Layout effect, not passive: the page commits and can paint before a passive
 * effect runs, so the safe-area strips would trail the page by a frame both on
 * arrival and whenever the color resolves. It also puts the strips' transition
 * in the same frame the page starts its own, which is what keeps the two in
 * step rather than merely equal in duration.
 *
 * Pass `null` to opt out (a screen whose color is owned by a child layer). The
 * cleanup only clears a surface this caller still owns, so a screen that mounts
 * before the outgoing one unmounts keeps its color instead of flashing the
 * neutral canvas, whether or not the two happen to share a color.
 */
export function usePublishPageSurface(
  surface: string | null,
  transition: string | null = null,
): void {
  const setSurface = usePageSurfaceStore.use.setSurface();
  const owner = useId();
  const published = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (surface === null) {
      return;
    }
    // A transition is for a change of color, not an arrival. A page takes its
    // canvas color outright when it mounts, so the strips do too, and only the
    // publisher's later changes animate. Without this a page resumed straight
    // onto a themed step would leave them fading up from the neutral canvas
    // while the page itself was already there.
    const changing =
      published.current !== null && published.current !== surface;
    published.current = surface;
    setSurface(surface, changing ? transition : null, owner);
  }, [surface, transition, owner, setSurface]);

  // Releasing is its own effect so that publishing a new color is one store
  // write rather than a clear followed by a set. The pair lands in a single
  // commit either way, but the clear would be a frame of the neutral canvas
  // the moment anything moved them apart.
  useLayoutEffect(
    () => () => {
      if (usePageSurfaceStore.getState().owner === owner) {
        setSurface(null);
      }
    },
    [owner, setSurface],
  );
}
