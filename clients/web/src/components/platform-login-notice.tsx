import { LogIn } from "lucide-react";
import { type ReactNode } from "react";
import { useLocation } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

import { useOnboardingLogin } from "@/hooks/use-onboarding-login";

interface PlatformLoginNoticeProps {
  /**
   * Why the surface needs a platform session — typically the existing
   * "Log in to the Vellum platform to {action}." sentence.
   */
  children: ReactNode;
  /** Forwarded to the underlying `Notice` (e.g. layout spacing). */
  className?: string;
}

/**
 * Info notice shown when `usePlatformGate()` returns `"disabled"`: the
 * surface is meaningful but there is no platform session. Pairs the
 * explanatory copy with an actionable "Log In" button (the shared
 * `useOnboardingLogin` flow) so the prompt isn't a dead end.
 *
 * The button mirrors the affordance used in the settings sidebar and the
 * active-assistant gate, including the loading → "Cancel" toggle.
 */
export function PlatformLoginNotice({
  children,
  className,
}: PlatformLoginNoticeProps) {
  // Return to the full current URL (including query/hash) after login so
  // params these surfaces depend on — e.g. billing's `?session_id` /
  // `?billing_status` — survive the auth round-trip. `useOnboardingLogin`
  // otherwise derives the return target from `pathname` only.
  const { pathname, search, hash } = useLocation();
  const { loading, login, cancel } = useOnboardingLogin(
    `${pathname}${search}${hash}`,
  );
  return (
    <Notice
      tone="info"
      className={className}
      actions={
        <Button
          variant="ghost"
          leftIcon={loading ? undefined : <LogIn className="h-4 w-4" />}
          onClick={loading ? cancel : () => void login()}
        >
          {loading ? "Cancel" : "Log In"}
        </Button>
      }
    >
      {children}
    </Notice>
  );
}
