import { Outlet } from "react-router";

import { useClientFeatureFlagSync } from "@/hooks/use-client-feature-flag-sync";
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
  // The account screens render before authentication, outside RootLayout (which
  // owns the post-auth flag sync). Sync client flags here too so flag-gated
  // sign-up (experiment-activation-flow-2026-06-03 → personal-page) can be
  // served to anonymous visitors. Failures degrade to registry defaults.
  useClientFeatureFlagSync(true);
  return <Outlet />;
}
