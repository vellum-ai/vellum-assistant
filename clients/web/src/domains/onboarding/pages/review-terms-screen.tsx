import { useCallback, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import { SettingRow } from "@/domains/onboarding/components/setting-row";
import {
    useAiDataConsent,
    useAnalyticsConsentCurrent,
    useDiagnosticsConsentCurrent,
    useShareAnalytics,
    useShareDiagnostics,
    useTosAccepted,
} from "@/domains/onboarding/prefs";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import { isElectron } from "@/runtime/is-electron";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import { saveConsent } from "@/utils/onboarding-cleanup";
import { sanitizeReturnTo } from "@/utils/return-to";
import { legalUrl, routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Checkbox } from "@vellumai/design-library/components/checkbox";

const CONSENT_CHECKBOX_CLASS =
  "[&_button[data-state=checked]]:bg-[var(--primary-base)] [&_svg]:text-[var(--content-inset)]";

export function ReviewTermsScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const userId = useAuthStore.use.user()?.id ?? null;
  const logout = useAuthStore.use.logout();
  const electron = isElectron();
  const hasPlatformSession = useHasPlatformSession();

  const [tosAccepted, setTosAccepted] = useTosAccepted();
  const [aiDataConsent, setAiDataConsent] = useAiDataConsent();
  const [shareAnalytics, setShareAnalytics] = useShareAnalytics();
  const [shareDiagnostics, setShareDiagnostics] = useShareDiagnostics();
  const [analyticsConsentCurrent] = useAnalyticsConsentCurrent();
  const [diagnosticsConsentCurrent] = useDiagnosticsConsentCurrent();

  const tosStale = !tosAccepted;
  const aiStale = !aiDataConsent;
  const analyticsStale = !analyticsConsentCurrent;
  const diagnosticsStale = !diagnosticsConsentCurrent;
  const onlyTogglesStale = !tosStale && !aiStale;

  const onContinue = useCallback(() => {
    saveConsent({ userId, tos: tosAccepted, ai: aiDataConsent, shareAnalytics, shareDiagnostics, hasPlatformSession });

    const destination = sanitizeReturnTo(searchParams.get("returnTo"), routes.assistant);
    void navigate(destination, { replace: true });
  }, [
    aiDataConsent,
    hasPlatformSession,
    navigate,
    searchParams,
    shareAnalytics,
    shareDiagnostics,
    tosAccepted,
    userId,
  ]);

  const handleLogout = useCallback(async () => {
    await logout();
    hardNavigate(routes.account.login);
  }, [logout]);

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

  // Only shown legal checkboxes gate Continue. Toggles never block — off is a
  // valid choice — so when only toggles are stale Continue is enabled.
  const continueDisabled = (tosStale && !tosAccepted) || (aiStale && !aiDataConsent);

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div
        className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-4 electron-prechat-type" : "px-6 py-16"} text-[var(--content-default)]`}
      >
        <h1
          className={electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          {onlyTogglesStale ? "Review your privacy preferences" : "Updated Terms"}
        </h1>
        <p
          className={`text-center text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-4"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          {onlyTogglesStale
            ? "We've updated our privacy preferences. Please review them to continue."
            : "We've updated our terms. Please review and re-accept to continue."}
        </p>

        {(analyticsStale || diagnosticsStale) && (
          <div
            className="mt-8 flex w-full flex-col gap-4"
            style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
          >
            {analyticsStale && (
              <SettingRow
                label="Share Analytics"
                helperText="Send anonymous product usage data."
                checked={shareAnalytics}
                onChange={setShareAnalytics}
              />
            )}
            {diagnosticsStale && (
              <SettingRow
                label="Share Diagnostics"
                helperText="Send crash reports and performance metrics."
                checked={shareDiagnostics}
                onChange={setShareDiagnostics}
              />
            )}
          </div>
        )}

        {aiStale && (
          <div
            className="mt-8 flex w-full items-start"
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
        )}

        {tosStale && (
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
        )}

        <div
          className={`mt-8 flex w-full flex-col ${electron ? "gap-2.5" : "gap-2"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={continueDisabled}
            onClick={onContinue}
            className={electron ? undefined : "h-11 text-base"}
          >
            Continue
          </Button>
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            onClick={handleLogout}
            className={electron ? undefined : "h-11 text-base"}
          >
            Log out
          </Button>
        </div>

      </div>
    </OnboardingLayout>
  );
}
