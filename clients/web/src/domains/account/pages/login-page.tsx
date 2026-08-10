import { useState } from "react";
import { Link, useLocation } from "react-router";

import { useTranslation } from "@/i18n";
import { NativeSplash } from "@/components/native-splash";
import { AuthWaitSpinner } from "@/domains/account/components/auth-wait-spinner";
import {
  DarkLoginShell,
  LoginCard,
  LoginErrorText,
  LoginHeading,
} from "@/domains/account/components/login-shell";
import { useReturnToShortCircuit } from "@/domains/account/hooks/use-return-to-short-circuit";
import {
  PROVIDER_ID,
  buildProviderCallbackUrl,
} from "@/domains/account/login-flow";
import {
  isUserCancelledAuthError,
  nativeAuthErrorDetail,
  AUTH_ERROR_COMMUNITY_LINK,
  nativeAuthErrorKey,
} from "@/domains/account/native-auth-error";
import { withPreservedAttribution } from "@/domains/account/social-auth";
import { captureError } from "@/lib/sentry/capture-error";
import {
  startAuthFlow,
  startNativeLogin,
  useIsNativePlatform,
} from "@/runtime/native-auth";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library";

/**
 * Capacitor native login: single "Sign in" button inside NativeSplash.
 * Opens the platform browser auth surface with no provider hint; WorkOS
 * AuthKit handles Apple / Google / email selection.
 */
function NativeLoginForm({ returnTo }: { returnTo: string | null }) {
  const { t } = useTranslation("account");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const triggerAuth = async () => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await startNativeLogin({ returnTo: returnTo ?? null });
    } catch (err) {
      if (isUserCancelledAuthError(err)) {
        setLoading(false);
        return;
      }
      // Report every real failure, classified or not. This is the screen the
      // "I tried to log in and it errored right away" reports come from, and
      // until now the classified branch logged nothing at all — so the reports
      // arrived with no trace of which refusal the platform issued.
      captureError(err, {
        context: "native_login",
        tags: { authError: nativeAuthErrorDetail(err) ?? "unclassified" },
      });
      setErrorMessage(
        t(nativeAuthErrorKey(err), { community: AUTH_ERROR_COMMUNITY_LINK }),
      );
      setLoading(false);
    }
  };

  const handleSignIn = () => {
    void triggerAuth();
  };

  return (
    <NativeSplash>
      <div className="z-10 mt-8 flex w-full max-w-[320px] flex-col items-center gap-3">
        {errorMessage && (
          <LoginErrorText className="max-w-[280px]">
            {errorMessage}
          </LoginErrorText>
        )}
        <Button
          type="button"
          variant="primary"
          fullWidth
          onClick={handleSignIn}
          disabled={loading}
          className="max-w-[300px]"
        >
          {t("loginPage.signIn")}
        </Button>
      </div>
    </NativeSplash>
  );
}

/**
 * Web / Electron login: a single CTA that hands off to WorkOS AuthKit (which
 * hosts the provider + email/password selection). Wrapped in a forced-dark
 * theme context (the web login screen is always dark per Figma).
 */
function WebLoginForm({ returnTo }: { returnTo: string | null }) {
  const { t } = useTranslation("account");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const callbackUrl = buildProviderCallbackUrl(returnTo);
  // Keep URL-borne attribution alive across the pivot to signup.
  const { search } = useLocation();
  const signUpHref = withPreservedAttribution(
    returnTo
      ? `${routes.account.signup}?returnTo=${encodeURIComponent(returnTo)}`
      : routes.account.signup,
    search,
  );

  const handleContinue = async () => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await startAuthFlow(PROVIDER_ID, callbackUrl, { returnTo });
    } catch (err) {
      captureError(err, {
        context: "web_login",
        tags: { authError: nativeAuthErrorDetail(err) ?? "unclassified" },
      });
      setErrorMessage(
        t(nativeAuthErrorKey(err), { community: AUTH_ERROR_COMMUNITY_LINK }),
      );
      setLoading(false);
    }
  };

  return (
    <DarkLoginShell>
      <LoginCard>
        <LoginHeading>{t("loginPage.heading")}</LoginHeading>
        {errorMessage && <LoginErrorText>{errorMessage}</LoginErrorText>}
        <div className="flex flex-col items-center gap-3">
          <Button
            type="button"
            variant="primary"
            fullWidth
            onClick={() => void handleContinue()}
            disabled={loading}
            className="max-w-[300px]"
          >
            {t("loginPage.continue")}
          </Button>
        </div>
        <p className="text-body-small-default flex justify-center gap-1">
          <span className="text-[var(--content-secondary)]">
            {t("loginPage.noAccount")}
          </span>
          <Link
            to={signUpHref}
            className="font-medium text-[var(--content-emphasised)] hover:underline"
          >
            {t("loginPage.signUp")}
          </Link>
        </p>
      </LoginCard>
    </DarkLoginShell>
  );
}

/**
 * Branded sign-in screen for `/account/login`.
 *
 * Delegates to `NativeLoginForm` (Capacitor native) or `WebLoginForm`
 * (standard browser / Electron) based on platform detection.
 *
 * `useReturnToShortCircuit` owns whether an existing session skips OAuth and
 * lands on the `returnTo` destination directly — the same decision
 * `SignupPage` makes. Only the loading shell differs.
 */
export function LoginPage() {
  const isNative = useIsNativePlatform();
  const shortCircuit = useReturnToShortCircuit();

  if (shortCircuit.kind === "wait") {
    return isNative ? (
      <NativeSplash />
    ) : (
      <DarkLoginShell>
        <AuthWaitSpinner />
      </DarkLoginShell>
    );
  }
  if (shortCircuit.kind === "redirect") {
    return shortCircuit.node;
  }

  if (isNative) {
    return <NativeLoginForm returnTo={shortCircuit.returnTo} />;
  }
  return <WebLoginForm returnTo={shortCircuit.returnTo} />;
}
