import { ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
    AgreementsCard,
    PrivacyPreferencesCard,
} from "@/domains/onboarding/components/consent-controls";
import {
    privacyChangeNotes,
    tosChangeNotes,
} from "@/domains/onboarding/consent-changelog";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
    useAnalyticsConsentCurrent,
    useDiagnosticsConsentCurrent,
    usePrivacyConsent,
    useShareAnalytics,
    useShareDiagnostics,
    useTosAccepted,
} from "@/domains/onboarding/prefs";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import { isElectron } from "@/runtime/is-electron";
import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import {
    PRIVACY_CONSENT_VERSION,
    TOS_CONSENT_VERSION,
    saveConsent,
} from "@/utils/onboarding-cleanup";
import { sanitizeReturnTo } from "@/utils/return-to";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";

export function ReviewTermsScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const userId = useAuthStore.use.user()?.id ?? null;
  const logout = useAuthStore.use.logout();
  const electron = isElectron();
  const hasPlatformSession = useHasPlatformSession();

  const [tosAccepted, setTosAccepted] = useTosAccepted();
  const [privacyConsent, setPrivacyConsent] = usePrivacyConsent();
  const [shareAnalytics, setShareAnalytics] = useShareAnalytics();
  const [shareDiagnostics, setShareDiagnostics] = useShareDiagnostics();
  const [analyticsConsentCurrent] = useAnalyticsConsentCurrent();
  const [diagnosticsConsentCurrent] = useDiagnosticsConsentCurrent();

  // Snapshot staleness at mount: these are the sections the user was routed
  // here to address. Gating render on live values would unmount a checkbox the
  // instant it's checked, so the user never sees the checked state.
  const [tosStaleAtMount] = useState(() => !tosAccepted);
  const [privacyStaleAtMount] = useState(() => !privacyConsent);
  const [analyticsStaleAtMount] = useState(() => !analyticsConsentCurrent);
  const [diagnosticsStaleAtMount] = useState(() => !diagnosticsConsentCurrent);

  // Direct navigation to this route with everything already current would
  // otherwise render an empty page. Treat that as a full review surface: show
  // every section so the page is meaningful and re-confirmable.
  const nothingStaleAtMount =
    !tosStaleAtMount &&
    !privacyStaleAtMount &&
    !analyticsStaleAtMount &&
    !diagnosticsStaleAtMount;
  const showTos = tosStaleAtMount || nothingStaleAtMount;
  const showPrivacy = privacyStaleAtMount || nothingStaleAtMount;
  const showAnalytics = analyticsStaleAtMount || nothingStaleAtMount;
  const showDiagnostics = diagnosticsStaleAtMount || nothingStaleAtMount;
  const onlyTogglesStaleAtMount =
    !nothingStaleAtMount && !tosStaleAtMount && !privacyStaleAtMount;

  const heading = nothingStaleAtMount
    ? "Terms & privacy"
    : onlyTogglesStaleAtMount
      ? "Review your privacy preferences"
      : "Updated terms";
  const subheading = nothingStaleAtMount
    ? "Review your terms and privacy preferences anytime."
    : onlyTogglesStaleAtMount
      ? "Confirm your privacy preferences to continue."
      : "We've updated our terms. Please review and accept to continue.";

  const onContinue = useCallback(() => {
    // Only persist analytics when its toggle was actually on screen — a user
    // routed here for other stale sections must not silently grant (or
    // re-stamp) analytics consent; the server keeps null until they choose.
    saveConsent({
      userId,
      tos: tosAccepted,
      privacy: privacyConsent,
      shareAnalytics: showAnalytics ? shareAnalytics : null,
      shareDiagnostics,
      hasPlatformSession,
    });

    const destination = sanitizeReturnTo(searchParams.get("returnTo"), routes.assistant);
    void navigate(destination, { replace: true });
  }, [
    privacyConsent,
    hasPlatformSession,
    navigate,
    searchParams,
    shareAnalytics,
    shareDiagnostics,
    showAnalytics,
    tosAccepted,
    userId,
  ]);

  const handleLogout = useCallback(async () => {
    await logout();
    hardNavigate(routes.account.login);
  }, [logout]);

  // Only the legal checkboxes shown at mount gate Continue, driven by their
  // live checked values. Toggles never block — off is a valid choice.
  const continueDisabled =
    (showTos && !tosAccepted) || (showPrivacy && !privacyConsent);

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div
        className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-4 electron-prechat-type" : "px-6 py-16"} text-[var(--content-default)]`}
      >
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-lift)]"
          style={{ animation: "fadeInUp 0.5s ease-out 0.05s both" }}
        >
          <ShieldCheck
            className="h-6 w-6 text-[var(--content-secondary)]"
            strokeWidth={1.75}
          />
        </div>
        <h1
          className={`mt-5 ${electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.12s both" }}
        >
          {heading}
        </h1>
        <p
          className={`text-center text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3" : "mt-3.5"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.2s both" }}
        >
          {subheading}
        </p>

        {(showAnalytics || showDiagnostics) && (
          <PrivacyPreferencesCard
            electron={electron}
            showAnalytics={showAnalytics}
            showDiagnostics={showDiagnostics}
            shareAnalytics={shareAnalytics}
            shareDiagnostics={shareDiagnostics}
            onShareAnalyticsChange={setShareAnalytics}
            onShareDiagnosticsChange={setShareDiagnostics}
            className="mt-9 w-full"
            style={{ animation: "fadeInUp 0.5s ease-out 0.28s both" }}
          />
        )}

        {(showPrivacy || showTos) && (
          <AgreementsCard
            electron={electron}
            showPrivacy={showPrivacy}
            showTos={showTos}
            privacyConsent={privacyConsent}
            tosAccepted={tosAccepted}
            onPrivacyChange={setPrivacyConsent}
            onTosChange={setTosAccepted}
            privacyNotes={showPrivacy ? privacyChangeNotes(PRIVACY_CONSENT_VERSION) : []}
            tosNotes={showTos ? tosChangeNotes(TOS_CONSENT_VERSION) : []}
            className="mt-6 w-full"
            style={{ animation: "fadeInUp 0.5s ease-out 0.36s both" }}
          />
        )}

        <div
          className={`mt-9 flex w-full flex-col ${electron ? "gap-2.5" : "gap-2"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.44s both" }}
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
