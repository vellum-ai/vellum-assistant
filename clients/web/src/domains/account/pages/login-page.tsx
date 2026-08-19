import { useState } from "react";
import { useLocation } from "react-router";

import { useTranslation } from "@/i18n";
import { NativeSplash } from "@/components/native-splash";
import {
  AuthWelcomeScreen,
  WelcomeScreenShell,
} from "@/components/auth-welcome-screen";
import { AuthWaitSpinner } from "@/domains/account/components/auth-wait-spinner";
import { LoginErrorText } from "@/domains/account/components/login-shell";
import { useReturnToShortCircuit } from "@/domains/account/hooks/use-return-to-short-circuit";
import {
  isUserCancelledAuthError,
  nativeAuthErrorDetail,
  AUTH_ERROR_COMMUNITY_LINK,
  nativeAuthErrorKey,
} from "@/domains/account/native-auth-error";
import { withPreservedAttribution } from "@/domains/account/social-auth";
import { captureError } from "@/lib/sentry/capture-error";
import { startNativeLogin, useIsNativePlatform } from "@/runtime/native-auth";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library";

/**
 * Capacitor native login: single "Sign in" button inside NativeSplash.
 * Opens the platform browser auth surface with no provider hint; WorkOS
 * AuthKit handles Apple / Google / email selection.
 *
 * Kept apart from the shared welcome screen the browser gets: the splash is
 * the native app's own launch surface, sized to the device's safe areas.
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
 * Web / Electron login: the same welcome screen `/assistant/welcome` shows,
 * which is what this is the platform-mode counterpart of. The log-in button
 * and the AuthKit handoff behind it come from `AuthWelcomeScreen`; the only
 * thing this build decides is what sits beside it — signup rather than local
 * mode's route past the account.
 */
function WebLoginForm({ returnTo }: { returnTo: string | null }) {
  const { t } = useTranslation("account");
  // Keep URL-borne attribution alive across the pivot to signup.
  const { search } = useLocation();
  const signUpHref = withPreservedAttribution(
    returnTo
      ? `${routes.account.signup}?returnTo=${encodeURIComponent(returnTo)}`
      : routes.account.signup,
    search,
  );

  return (
    <AuthWelcomeScreen
      returnTo={returnTo}
      errorContext="web_login"
      // `/account/*` renders outside `RootLayout`, so this screen supplies the
      // viewport height the layout sizes against.
      fillsViewport
      secondary={{ label: t("loginPage.signUp"), href: signUpHref }}
    />
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
      <WelcomeScreenShell fillsViewport>
        <AuthWaitSpinner />
      </WelcomeScreenShell>
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
