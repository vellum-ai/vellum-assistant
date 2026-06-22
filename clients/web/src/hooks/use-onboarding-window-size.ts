import { useEffect } from "react";
import { useLocation } from "react-router";

import { setOnboardingWindow } from "@/runtime/main-window";

/**
 * Route prefixes that should render in the compact (440×630) window: the
 * onboarding flow (`/assistant/onboarding/*`) and the standalone auth
 * screens (`/account/*` — login, signup, password reset, OAuth callbacks).
 * Both are chrome-less, narrow, pre-app surfaces. Everything else (the main
 * app) uses the large window.
 *
 * The `/account` prefix assumes the hook is only mounted on `/account`
 * routes that render in the MAIN window (login, signup, etc., via
 * `AccountLayout`). The OAuth completion pages (`oauth/popup-complete` etc.)
 * also match this prefix but render inside a popup child window — they're
 * kept OUT of `AccountLayout` in `routes.tsx` so the hook never mounts
 * there. Same hazard as `/assistant/about`, which renders in a separate
 * About `BrowserWindow` and likewise never mounts this hook: the resize IPC
 * targets the main window, so signalling from any non-main window would
 * resize the wrong window.
 */
const COMPACT_PATH_PREFIXES = [
  "/assistant/onboarding/",
  "/assistant/welcome",
  "/assistant/select-assistant",
  "/assistant/review-terms",
  "/account",
];

function isCompactRoute(pathname: string): boolean {
  return COMPACT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Keep the Electron main window sized to the compact layout (440×630,
 * matching the macOS Swift client) while on a compact route — onboarding or
 * the `/account/*` auth screens — and large everywhere else in the app.
 *
 * Mounted on every route group whose content lives in the main window:
 * `RootLayout` (the `/assistant` app, incl. onboarding) and the `/account`
 * layout. Off Electron the call is a no-op, so this is inert on web and iOS.
 * Driving it from the route — not the `onboarding.completed` flag — keeps
 * the small window applied across the whole pre-app surface, including the
 * post-completion-flag prechat/hatching screens.
 */
export function useOnboardingWindowSize(): void {
  const { pathname } = useLocation();
  const isCompact = isCompactRoute(pathname);

  // Depend on the derived boolean, not the raw pathname, so the effect (and
  // its IPC round-trip) only runs when compact-ness actually flips — not on
  // every navigation within a group.
  useEffect(() => {
    void setOnboardingWindow(isCompact);
  }, [isCompact]);
}
