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
 * Publishers register from a `useEffect` and clear on unmount, the same
 * convention as the header slots in `chat-layout-slots-store`.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

interface PageSurfaceState {
  /**
   * A CSS color value (usually a `var(--surface-*)` reference), or null to fall
   * back to the shell's neutral canvas.
   */
  surface: string | null;
}

interface PageSurfaceActions {
  setSurface: (surface: string | null) => void;
}

const usePageSurfaceStoreBase = create<PageSurfaceState & PageSurfaceActions>(
  (set) => ({
    surface: null,
    setSurface: (surface) =>
      set((state) => (state.surface === surface ? state : { surface })),
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
