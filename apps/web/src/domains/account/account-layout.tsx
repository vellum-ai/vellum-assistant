import { Outlet } from "react-router";

import { useOnboardingWindowSize } from "@/hooks/use-onboarding-window-size";

/**
 * Layout for the standalone `/account/*` auth screens (login, signup,
 * password reset, OAuth callbacks). These render outside `RootLayout`, so
 * this is where the compact-window sizing hook is mounted for them — the
 * auth screens use the same small (440×630) window as onboarding. Renders
 * no chrome of its own; the pages own their layout.
 */
export function AccountLayout() {
  useOnboardingWindowSize();
  return <Outlet />;
}
