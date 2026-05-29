import * as Sentry from "@sentry/browser";
import { EyeOff } from "lucide-react";
import { useEffect, useId, useCallback, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Checkbox } from "@vellum/design-library/components/checkbox";
import { Toggle } from "@vellum/design-library/components/toggle";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { StepIndicatorDots } from "@/domains/onboarding/components/step-indicator-dots";
import {
  emitOnboardingFunnelStepCompleted,
  getOnboardingFunnelSessionId,
  onboardingFunnelVariantFromCondensedFlag,
  ONBOARDING_FUNNEL_STEPS,
  resolveOnboardingFunnelVariant,
} from "@/domains/onboarding/funnel-events";
import {
  readOnboardingCompleted,
  useAiDataConsent,
  useShareAnalytics,
  useShareDiagnostics,
  useTosAccepted,
} from "@/domains/onboarding/prefs";
import { markPrivacyConsent } from "@/domains/onboarding/signals";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useAuthStore } from "@/stores/auth-store";
import { legalUrl, routes } from "@/utils/routes";

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

export function PrivacyScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isReplay = searchParams.get("replay") === "1";
  const userId = useAuthStore.use.user()?.id ?? null;
  const isNative = useIsNativePlatform();
  const condensedPrechatFlag =
    useClientFeatureFlagStore.use.prechatOnboardingCondensedFlow();
  const preferredFunnelVariant =
    onboardingFunnelVariantFromCondensedFlag(condensedPrechatFlag);
  const [shareAnalytics, setShareAnalytics] = useShareAnalytics();
  const [shareDiagnostics, setShareDiagnostics] = useShareDiagnostics();
  const [tosAccepted, setTosAccepted] = useTosAccepted();
  const [aiDataConsent, setAiDataConsent] = useAiDataConsent();

  useEffect(() => {
    if (!isNative && !isReplay) {
      getOnboardingFunnelSessionId();
    }
  }, [isNative, isReplay]);

  useEffect(() => {
    if (readOnboardingCompleted() && !isReplay) {
      void navigate(routes.assistant, { replace: true });
    }
  }, [isReplay, navigate]);

  const onStart = useCallback(() => {
    try {
      setShareAnalytics(shareAnalytics);
      setShareDiagnostics(shareDiagnostics);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { context: "onboarding_persist_share_prefs" },
      });
    }
    markPrivacyConsent(userId);
    if (!isNative && !isReplay) {
      const variant = resolveOnboardingFunnelVariant(preferredFunnelVariant);
      emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.privacyTos, {
        userId,
        variant,
      });
    }
    void navigate(
      isReplay
        ? `${routes.onboarding.hatching}?replay=1`
        : routes.onboarding.hatching,
    );
  }, [
    isNative,
    isReplay,
    navigate,
    preferredFunnelVariant,
    setShareAnalytics,
    setShareDiagnostics,
    shareAnalytics,
    shareDiagnostics,
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
      <div className="mx-auto flex w-full max-w-xl flex-col items-center px-6 py-16 text-[var(--content-default)]">
        {isNative && (
          <div
            className="mb-8 flex w-full justify-center"
            style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
          >
            <StepIndicatorDots current={2} total={3} />
          </div>
        )}
        {/* typography: off-scale — hero onboarding h1 (30px) larger than text-title-large (24px) to match macOS visual weight */}
        <h1 className="text-3xl font-semibold tracking-tight">
          Before You Start
        </h1>
        <p className="mt-4 text-center text-body-medium-lighter text-[var(--content-tertiary)]">
          Choose your privacy preferences. You can update these anytime in the
          Settings.
        </p>

        <Card padding="md" className="mt-8 w-full">
          <div className="flex flex-col gap-4">
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

        <div className="mt-6 flex w-full items-start">
          <Checkbox
            checked={aiDataConsent}
            onCheckedChange={(next) => setAiDataConsent(next === true)}
            label={aiConsentLabel}
            aria-label="I agree to the AI Data Sharing Policy"
          />
        </div>

        <div className="mt-4 flex w-full items-start">
          <Checkbox
            checked={tosAccepted}
            onCheckedChange={(next) => setTosAccepted(next === true)}
            label={tosLabel}
            aria-label="I agree to the Terms of Service and Privacy Policy"
          />
        </div>

        <div className="mt-8 flex w-full flex-col gap-2">
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={!tosAccepted || !aiDataConsent}
            onClick={onStart}
            className="h-11 text-base"
          >
            Start
          </Button>
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            onClick={() => navigate(-1)}
            className="h-11 text-base"
          >
            Back
          </Button>
        </div>

      </div>
    </OnboardingLayout>
  );
}
