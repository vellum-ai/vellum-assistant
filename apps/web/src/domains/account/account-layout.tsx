import { Outlet } from "react-router";

import { useOnboardingWindowSize } from "@/hooks/use-onboarding-window-size";

/**
 * Layout for the `/account/*` auth screens that render in the MAIN window —
 * login, signup, provider sign-in callbacks, password reset. These live
 * outside `RootLayout`, so this is where the compact-window sizing hook is
 * mounted for them: they use the same small (440×630) window as onboarding.
 *
 * Deliberately does NOT wrap the OAuth completion / loopback pages
 * (`oauth/popup-complete`, `oauth/complete`, `platform-callback`). Those
 * render inside an OAuth popup child window, and the sizing IPC targets the
 * module-scoped main window — so signalling from a popup would shrink the
 * wrong (main) window and persist `onboardingActive`. They're kept out of
 * this layout in `routes.tsx`. Renders no chrome of its own.
 */
export function AccountLayout() {
  useOnboardingWindowSize();
  return <Outlet />;
}
