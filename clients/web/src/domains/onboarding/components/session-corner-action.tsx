import { LogIn, LogOut } from "lucide-react";

import { hardNavigate } from "@/lib/auth/hard-navigate";
import { isElectron } from "@/runtime/is-electron";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import { Button } from "@vellumai/design-library/components/button";

/**
 * Quiet session control pinned to the top-right corner of the pre-chat
 * chooser screens: "Log in" without a platform session, "Log out" with one.
 * Escapes the layout's scroll container by positioning against the
 * OnboardingLayout root, clearing the iOS status bar via the safe-area inset.
 *
 * Hidden on electron — the compact Swift-parity onboarding windows keep
 * their own login affordances.
 *
 * Login rides the screen's own `useOnboardingLogin` instance (passed in) so
 * the corner control and any in-flow login affordance share pending state.
 * Logout ends the platform session and reloads the page in place, so the
 * screen re-resolves in its logged-out state — or the route middleware
 * redirects if this runtime requires a session.
 */
export function SessionCornerAction({
  loginLoading,
  onLogin,
  onCancelLogin,
}: {
  loginLoading: boolean;
  onLogin: () => void;
  onCancelLogin: () => void;
}) {
  const hasPlatformSession = useHasPlatformSession();
  const logout = useAuthStore.use.logout();

  if (isElectron()) {
    return null;
  }

  const handleLogout = async () => {
    await logout();
    hardNavigate(window.location.pathname + window.location.search);
  };

  return (
    <div
      className="absolute right-6 top-[max(1.5rem,env(safe-area-inset-top))] z-10"
      style={{ animation: "fadeInUp 0.5s ease-out 0.2s both" }}
    >
      <Button
        variant="ghost"
        size="compact"
        className="text-[var(--content-tertiary)]"
        leftIcon={hasPlatformSession ? <LogOut /> : <LogIn />}
        onClick={
          hasPlatformSession
            ? () => void handleLogout()
            : loginLoading
              ? onCancelLogin
              : onLogin
        }
      >
        {hasPlatformSession ? "Log out" : loginLoading ? "Cancel" : "Log in"}
      </Button>
    </div>
  );
}
