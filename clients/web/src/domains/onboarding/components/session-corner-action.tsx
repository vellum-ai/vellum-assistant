import { LogIn, LogOut } from "lucide-react";
import { useNavigate } from "react-router";

import { handleLogout } from "@/lib/auth/handle-logout";
import { isElectron } from "@/runtime/is-electron";
import { useHasPlatformSession } from "@/stores/auth-store";
import { Button } from "@vellumai/design-library/components/button";

/**
 * Quiet session control pinned to the top-right corner of the pre-chat
 * chooser screens: "Log in" without a platform session, "Log out" with one.
 * Escapes the layout's scroll container by positioning against the
 * OnboardingLayout root, clearing the iOS status bar via the safe-area inset.
 *
 * Hidden on electron: the compact Swift-parity onboarding windows keep
 * their own login affordances.
 *
 * Login rides the screen's own `useOnboardingLogin` instance (passed in) so
 * the corner control and any in-flow login affordance share pending state.
 * Logout delegates to the local-mode-aware `handleLogout`: with an active
 * local assistant it drops only the platform session (this screen then
 * re-renders logged out in place); otherwise it runs the full logout and
 * owns the resulting navigation.
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
  const navigate = useNavigate();
  const hasPlatformSession = useHasPlatformSession();

  if (isElectron()) {
    return null;
  }

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
            ? () => void handleLogout(navigate)
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
