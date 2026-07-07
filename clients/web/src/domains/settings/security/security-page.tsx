import { Navigate } from "react-router";

import { DetailCard } from "@/components/detail-card";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { routes } from "@/utils/routes";

import { TwoFactorSection } from "./two-factor-section";

/** `/assistant/settings/security` — two-factor authentication management. */
export function SecurityPage() {
  const accountMfaEnabled = useClientFeatureFlagStore.use.accountMfa();
  const flagsHydrated = useClientFeatureFlagStore.use.hydrated();
  // Default gate, not `platformHostedOnly` — the account exists
  // independently of the active assistant's hosting.
  const platformGate = usePlatformGate();

  // Deep-link defense; only redirect after hydration or a cold load
  // races the flag fetch.
  if (flagsHydrated && !accountMfaEnabled) {
    return <Navigate replace to={routes.settings.general} />;
  }
  if (!accountMfaEnabled || platformGate === "gated") {
    return null;
  }

  return (
    <div className="space-y-4">
      <DetailCard
        title="Two-Factor Authentication"
        subtitle="Require a code from an authenticator app when you sign in."
      >
        {platformGate === "disabled" ? (
          <PlatformLoginNotice>
            Log in to the Vellum platform to manage two-factor
            authentication.
          </PlatformLoginNotice>
        ) : (
          <TwoFactorSection />
        )}
      </DetailCard>
    </div>
  );
}
