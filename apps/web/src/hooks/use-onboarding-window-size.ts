import { useEffect } from "react";
import { useLocation } from "react-router";

import { setOnboardingWindow } from "@/runtime/main-window";

/**
 * Shared path prefix of every onboarding step route (welcome, hosting,
 * api-key, privacy, prechat, hatching — all under
 * `/assistant/onboarding/*`; see `routes.onboarding` in `@/utils/routes`).
 * Matching the prefix keeps the onboarding window size applied for the
 * whole flow without re-listing each step.
 */
const ONBOARDING_PATH_PREFIX = "/assistant/onboarding/";

/**
 * Keep the Electron main window sized to the onboarding layout (440×630,
 * matching the macOS Swift client) while an onboarding step is showing,
 * and let it grow back to the resizable main-app size everywhere else.
 *
 * Mounted once at the app root (`RootLayout`). Off Electron the call is a
 * no-op, so this is inert on web and iOS. Driving it from the route — not
 * the `onboarding.completed` flag — keeps the small window applied across
 * every step (including the post-completion-flag prechat/hatching screens,
 * which the macOS client also shows in the small window).
 */
export function useOnboardingWindowSize(): void {
  const { pathname } = useLocation();
  const isOnboarding = pathname.startsWith(ONBOARDING_PATH_PREFIX);

  // Depend on the derived boolean, not the raw pathname, so the effect
  // (and its IPC round-trip) only runs when onboarding-ness actually flips
  // — not on every navigation within the app or within the flow.
  useEffect(() => {
    void setOnboardingWindow(isOnboarding);
  }, [isOnboarding]);
}
