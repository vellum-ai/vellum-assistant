import { useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
    AgreementsCard,
    PrivacyPreferencesCard,
} from "@/domains/onboarding/components/consent-controls";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { StepIndicatorDots } from "@/domains/onboarding/components/step-indicator-dots";
import {
    emitOnboardingFunnelStepCompleted,
    getOnboardingFunnelSessionId,
    ONBOARDING_FUNNEL_STEPS,
    onboardingFunnelVariantFromExperiment,
    resolveOnboardingFunnelVariant,
} from "@/domains/onboarding/funnel-events";
import { onboardingDestinationAfterConsent } from "@/domains/onboarding/onboarding-destination";
import { isLocalHatchHosting } from "@/lib/local-mode";
import {
    usePrivacyConsent,
    useShareAnalytics,
    useShareDiagnostics,
    useTosAccepted,
} from "@/domains/onboarding/prefs";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { saveConsent } from "@/utils/onboarding-cleanup";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

export function PrivacyScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const userId = useAuthStore.use.user()?.id ?? null;
  const electron = isElectron();
  const isNative = useIsNativePlatform();
  const preChatExperimentArm =
    useClientFeatureFlagStore.use.stringFlags().preChatOnboardingExperiment20260606 ?? "control";
  const preferredFunnelVariant =
    onboardingFunnelVariantFromExperiment(preChatExperimentArm);
  const [shareAnalytics, setShareAnalyticsReal] = useShareAnalytics();
  const [shareDiagnostics, setShareDiagnosticsReal] = useShareDiagnostics();
  const [tosAccepted, setTosAcceptedReal] = useTosAccepted();
  const [privacyConsent, setPrivacyConsentReal] = usePrivacyConsent();
  const hasPlatformSession = useHasPlatformSession();

  useEffect(() => {
    if (!isNative) {
      getOnboardingFunnelSessionId();
    }
  }, [isNative]);

  const isPreview = searchParams.get("preview") === "true";
  const noop = useCallback((_next: boolean) => {}, []);
  const setShareAnalytics = isPreview ? noop : setShareAnalyticsReal;
  const setShareDiagnostics = isPreview ? noop : setShareDiagnosticsReal;
  const setTosAccepted = isPreview ? noop : setTosAcceptedReal;
  const setPrivacyConsent = isPreview ? noop : setPrivacyConsentReal;

  const onStart = useCallback(() => {
    if (isPreview) {
      // Developer "Replay Onboarding": advance through the sandboxed flow
      // (privacy → prechat) rather than exiting here. Hatching is intentionally
      // skipped — it has real side effects and is excluded from the preview
      // route allowlist in onboardingCompletedMiddleware.
      void navigate(`${routes.onboarding.prechat}?preview=true`);
      return;
    }

    saveConsent({ userId, tos: tosAccepted, privacy: privacyConsent, shareAnalytics, shareDiagnostics, hasPlatformSession });
    if (!isNative) {
      const variant = resolveOnboardingFunnelVariant(preferredFunnelVariant);
      emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.privacyTos, {
        userId,
        variant,
      });
    }

    const hostingParam = searchParams.get("hosting");
    const params = new URLSearchParams();
    if (hostingParam) params.set("hosting", hostingParam);
    const qs = params.toString();
    // A local-hosting onboarding (hosting=local/docker in a local-mode build)
    // must run the foreground local hatch first, so it goes to `hatching`, which
    // then redirects into the research flow. Vellum-Cloud goes straight to
    // research (managed background hatch).
    const isLocalHatch = isLocalHatchHosting(hostingParam);
    const destination = onboardingDestinationAfterConsent({
      isNative,
      isLocalHatch,
    });
    void navigate(`${destination}${qs ? `?${qs}` : ""}`);
  }, [
    privacyConsent,
    hasPlatformSession,
    isNative,
    isPreview,
    navigate,
    preferredFunnelVariant,
    searchParams,
    shareAnalytics,
    shareDiagnostics,
    tosAccepted,
    userId,
  ]);

  return (
    <OnboardingLayout>
      <div
        className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-4 electron-prechat-type" : "px-6 py-16"} text-[var(--content-default)]`}
      >
        {isNative && (
          <div
            className="mb-8 flex w-full justify-center"
            style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
          >
            <StepIndicatorDots current={2} total={3} />
          </div>
        )}
        <h1
          className={electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          Before You Start
        </h1>
        <p
          className={`text-center text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-4"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          Choose your privacy preferences. You can update these anytime in the
          Settings.
        </p>

        <PrivacyPreferencesCard
          electron={electron}
          shareAnalytics={shareAnalytics}
          shareDiagnostics={shareDiagnostics}
          onShareAnalyticsChange={setShareAnalytics}
          onShareDiagnosticsChange={setShareDiagnostics}
          className="mt-8 w-full"
          style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
        />

        <AgreementsCard
          electron={electron}
          privacyConsent={privacyConsent}
          tosAccepted={tosAccepted}
          onPrivacyChange={setPrivacyConsent}
          onTosChange={setTosAccepted}
          className="mt-6 w-full"
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        />

        <div
          className={`mt-8 flex w-full flex-col ${electron ? "gap-2.5" : "gap-2"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.55s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={!tosAccepted || !privacyConsent}
            onClick={onStart}
            className={electron ? undefined : "h-11 text-base"}
          >
            Start
          </Button>
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            onClick={() => navigate(-1)}
            className={electron ? undefined : "h-11 text-base"}
          >
            Back
          </Button>
        </div>

      </div>
    </OnboardingLayout>
  );
}
