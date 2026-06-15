import { Suspense, lazy } from "react";

import { PreChatFlow } from "@/domains/onboarding/pages/pre-chat-flow";
import { usePreChatConsentGate } from "@/domains/onboarding/use-prechat-consent-gate";
import { useActivationFlowArm } from "@/hooks/use-client-feature-flag-sync";

const CastOnboardingFlow = lazy(() =>
  import("@/domains/onboarding/cast/cast-onboarding-flow").then((m) => ({
    default: m.CastOnboardingFlow,
  })),
);

/**
 * Cast branch wrapper that enforces the same consent gate the legacy
 * `PreChatFlow` runs internally. Without this, a user who navigates directly
 * to `/assistant/onboarding/prechat` on the personal-page arm would mount the
 * cast flow without ever having accepted ToS / AI-data consent. Mirrors
 * `pre-chat-flow.tsx`: redirect to the privacy screen until consent is ready.
 */
function CastPreChatFlow() {
  const consentReady = usePreChatConsentGate();
  if (!consentReady) return null;

  return (
    <Suspense fallback={null}>
      <CastOnboardingFlow />
    </Suspense>
  );
}

/**
 * Routing seam for `onboarding/prechat`. Picks the onboarding flow by
 * activation arm: the `experiment-activation-flow-2026-06-03 = personal-page`
 * arm gets the new `CastOnboardingFlow`, everyone else (control / variant-a)
 * keeps the legacy `PreChatFlow`.
 *
 * Nothing renders until the flag has `settled` (server fetch resolved/errored)
 * — otherwise a targeted anonymous visitor would briefly see the control
 * `PreChatFlow` on the registry default before their `personal-page` value
 * arrives. Mirrors the settle-guard in `account/pages/signup-page.tsx`.
 */
export function PreChatRoute() {
  const { arm, settled } = useActivationFlowArm();

  // Hold rendering until the flag resolves to avoid flashing the wrong flow.
  if (!settled) return null;

  if (arm === "personal-page") {
    return <CastPreChatFlow />;
  }

  return <PreChatFlow />;
}
