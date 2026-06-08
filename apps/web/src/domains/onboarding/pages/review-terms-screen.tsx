import { useCallback, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
    useAiDataConsent,
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
  const [shareAnalytics] = useShareAnalytics();
  const [shareDiagnostics] = useShareDiagnostics();

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

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div
        className={`mx-auto flex w-full max-w-xl flex-col items-center px-6 ${electron ? "pb-16" : "py-16"} text-[var(--content-default)]`}
        style={
          electron
            ? {
                paddingTop:
                  "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 1.5rem)",
              }
            : undefined
        }
      >
        <h1 className="text-3xl font-semibold tracking-tight">
          Updated Terms
        </h1>
        <p className="mt-4 text-center text-body-medium-lighter text-[var(--content-tertiary)]">
          We&apos;ve updated our terms. Please review and re-accept to continue.
        </p>

        <div className="mt-8 flex w-full items-start">
          <Checkbox
            checked={aiDataConsent}
            onCheckedChange={(next) => setAiDataConsent(next === true)}
            label={aiConsentLabel}
            aria-label="I agree to the AI Data Sharing Policy"
            className={CONSENT_CHECKBOX_CLASS}
          />
        </div>

        <div className="mt-4 flex w-full items-start">
          <Checkbox
            checked={tosAccepted}
            onCheckedChange={(next) => setTosAccepted(next === true)}
            label={tosLabel}
            aria-label="I agree to the Terms of Service and Privacy Policy"
            className={CONSENT_CHECKBOX_CLASS}
          />
        </div>

        <div className="mt-8 flex w-full flex-col gap-2">
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={!tosAccepted || !aiDataConsent}
            onClick={onContinue}
            className="h-11 text-base"
          >
            Continue
          </Button>
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            onClick={handleLogout}
            className="h-11 text-base"
          >
            Log out
          </Button>
        </div>

      </div>
    </OnboardingLayout>
  );
}
