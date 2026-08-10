/**
 * Viewport options shared by every story, so a story that cares about width
 * names one instead of declaring its own.
 *
 * Tailwind's `md` breakpoint at 768px is the line that matters here: the app's
 * rows carry `max-md:` variants for the mobile drawer, and those key off the
 * viewport rather than any prop. A story rendered narrower than that shows the
 * drawer's metrics, which is a combination the desktop rail never ships.
 */
export const SB_VIEWPORTS = {
  sbDesktop: {
    name: "Desktop",
    styles: { width: "1280px", height: "760px" },
    type: "desktop" as const,
  },
  sbMobile: {
    name: "Mobile",
    styles: { width: "390px", height: "844px" },
    type: "mobile" as const,
  },
};

/** The width stories start at. See `preview.tsx` for why it is not pinned. */
export const SB_DESKTOP_VIEWPORT = "sbDesktop";
