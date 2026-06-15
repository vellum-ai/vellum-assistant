import { EyeOff } from "lucide-react";
import { useCallback, useEffect, useId, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { StepIndicatorDots } from "@/domains/onboarding/components/step-indicator-dots";
import {
    emitOnboardingFunnelStepCompleted,
    getOnboardingFunnelSessionId,
    ONBOARDING_FUNNEL_STEPS,
    onboardingFunnelVariantFromExperiment,
    resolveOnboardingFunnelVariant,
} from "@/domains/onboarding/funnel-events";
import {
    useAiDataConsent,
    useShareAnalytics,
    useShareDiagnostics,
    useTosAccepted,
} from "@/domains/onboarding/prefs";
import { useActivationFlowArm } from "@/hooks/use-client-feature-flag-sync";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { saveConsent } from "@/utils/onboarding-cleanup";
import { legalUrl, routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Checkbox } from "@vellumai/design-library/components/checkbox";
import { Toggle } from "@vellumai/design-library/components/toggle";

function SettingRow({
  label,
  helperText,
  checked,
  onChange,
}: {
  label: string;
  helperText: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const toggleId = useId();
  return (
    <div className="flex items-start gap-4">
      <Toggle
        checked={checked}
        onChange={onChange}
        id={toggleId}
      />
      <label htmlFor={toggleId} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-body-medium-default text-[var(--content-default)]">
          {label}
        </span>
        <span className="mt-1 block text-body-small-default text-[var(--content-tertiary)]">
          {helperText}
        </span>
      </label>
    </div>
  );
}

// Consent checkboxes mirror the primary button: the checked fill uses
// --primary-base and the check uses --content-inset (the on-primary
// foreground). This stays correct in every theme — dark fill + white check in
// light mode, white fill + dark check in dark mode — whereas the design
// library's hardcoded white check vanishes on the near-white dark-mode fill.
const CONSENT_CHECKBOX_CLASS =
  "[&_button[data-state=checked]]:bg-[var(--primary-base)] [&_svg]:text-[var(--content-inset)]";

export function PrivacyScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const userId = useAuthStore.use.user()?.id ?? null;
  const electron = isElectron();
  const isNative = useIsNativePlatform();
  const preChatExperimentArm =
    useClientFeatureFlagStore.use.stringFlags().preChatOnboardingExperiment20260606 ?? "control";
  // The cast / personal-page activation arm owns its own provisioning: its
  // pre-chat flow background-hatches the assistant, so post-consent it skips
  // the standalone hatching screen and goes straight to prechat. Every other
  // arm (control / variant-a) keeps the hatching step.
  // `arm` is provisionally `control` until `settled` — gating Start on
  // `settled` ensures a targeted personal-page user can't accept consent and
  // get routed down the non-cast (hatching) path before their arm resolves.
  const { arm: activationArm, settled: activationSettled } =
    useActivationFlowArm();
  const isCastArm = activationArm === "personal-page";
  const preferredFunnelVariant =
    onboardingFunnelVariantFromExperiment(preChatExperimentArm);
  const [shareAnalytics, setShareAnalyticsReal] = useShareAnalytics();
  const [shareDiagnostics, setShareDiagnosticsReal] = useShareDiagnostics();
  const [tosAccepted, setTosAcceptedReal] = useTosAccepted();
  const [aiDataConsent, setAiDataConsentReal] = useAiDataConsent();
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
  const setAiDataConsent = isPreview ? noop : setAiDataConsentReal;

  const onStart = useCallback(() => {
    if (isPreview) {
      // Developer "Replay Onboarding": advance through the sandboxed flow
      // (privacy → prechat) rather than exiting here. Hatching is intentionally
      // skipped — it has real side effects and is excluded from the preview
      // route allowlist in onboardingCompletedMiddleware.
      void navigate(`${routes.onboarding.prechat}?preview=true`);
      return;
    }

    saveConsent({ userId, tos: tosAccepted, ai: aiDataConsent, shareAnalytics, shareDiagnostics, hasPlatformSession });
    if (!isNative) {
      const variant = resolveOnboardingFunnelVariant(preferredFunnelVariant);
      emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.privacyTos, {
        userId,
        variant,
      });
    }

    // Cast arm: skip the standalone hatching screen — the prechat flow
    // background-hatches its own assistant.
    if (isCastArm) {
      void navigate(routes.onboarding.prechat);
      return;
    }

    const hostingParam = searchParams.get("hosting");
    const params = new URLSearchParams();
    if (hostingParam) params.set("hosting", hostingParam);
    const qs = params.toString();
    void navigate(`${routes.onboarding.hatching}${qs ? `?${qs}` : ""}`);
  }, [
    aiDataConsent,
    hasPlatformSession,
    isCastArm,
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

  const tosLabel: ReactNode = (
    <span className="text-body-medium-lighter text-[var(--content-default)]">
      I agree to the{" "}
      <a
        href={legalUrl(routes.docs.legal.termsOfUse)}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        Terms of Service
      </a>{" "}
      and{" "}
      <a
        href={legalUrl(routes.docs.legal.privacyPolicy)}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        Privacy Policy
      </a>
    </span>
  );

  const aiConsentLabel: ReactNode = (
    <span className="text-body-medium-lighter text-[var(--content-default)]">
      I agree to the{" "}
      <a
        href={legalUrl(routes.docs.legal.dataSharing)}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        AI Data Sharing Policy
      </a>
    </span>
  );

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

        <Card
          padding={electron ? "sm" : "md"}
          className="mt-8 w-full"
          style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
        >
          <div className={`flex flex-col ${electron ? "gap-3" : "gap-4"}`}>
            <SettingRow
              label="Share Analytics"
              helperText="Send anonymous product usage data."
              checked={shareAnalytics}
              onChange={setShareAnalytics}
            />
            <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
            <SettingRow
              label="Share Diagnostics"
              helperText="Send crash reports and performance metrics."
              checked={shareDiagnostics}
              onChange={setShareDiagnostics}
            />
            <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />
            <div className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
              <EyeOff className="h-4 w-4 shrink-0" />
              <span>Your conversations and personal data are never included.</span>
            </div>
          </div>
        </Card>

        <div
          className={`flex w-full items-start ${electron ? "mt-4" : "mt-6"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.45s both" }}
        >
          <Checkbox
            checked={aiDataConsent}
            onCheckedChange={(next) => setAiDataConsent(next === true)}
            label={aiConsentLabel}
            aria-label="I agree to the AI Data Sharing Policy"
            className={CONSENT_CHECKBOX_CLASS}
          />
        </div>

        <div
          className={`flex w-full items-start ${electron ? "mt-2" : "mt-4"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          <Checkbox
            checked={tosAccepted}
            onCheckedChange={(next) => setTosAccepted(next === true)}
            label={tosLabel}
            aria-label="I agree to the Terms of Service and Privacy Policy"
            className={CONSENT_CHECKBOX_CLASS}
          />
        </div>

        <div
          className={`mt-8 flex w-full flex-col ${electron ? "gap-2.5" : "gap-2"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.55s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={
              !tosAccepted ||
              !aiDataConsent ||
              // Don't act on a provisional arm: hold Start until the activation
              // flag settles so the cast-vs-hatching decision is final. Preview
              // doesn't branch on the arm, so it isn't gated.
              (!isPreview && !activationSettled)
            }
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
