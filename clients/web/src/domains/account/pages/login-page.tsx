import { useState } from "react";
import { useLocation } from "react-router";

import { useTranslation } from "@/i18n";
import {
  AuthWelcomeScreen,
  WelcomeScreenCopy,
  WelcomeScreenShell,
} from "@/components/auth-welcome-screen";
import { AuthWaitSpinner } from "@/domains/account/components/auth-wait-spinner";
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
 * Capacitor native login. Opens the platform browser auth surface with no
 * provider hint; WorkOS AuthKit handles Apple / Google / email selection.
 *
 * Renders the welcome shell the browser renders, including the avatar wave
 * that wraps around the content on a phone, and puts a single button in it.
 * The button is a constraint, not a layout choice: AuthKit hosts the provider
 * selection so the app never names a provider itself, and nothing else sits
 * beside it. See `docs/CAPACITOR.md`, "Native auth on iOS".
 *
 * The handoff is the part that is native. `startNativeLogin` goes out through
 * the `NativeAuth` plugin instead of navigating the page, because Google
 * refuses OAuth in an embedded WebView, so this screen stays mounted for the
 * whole flow and the button goes inert rather than the page going away.
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
    <WelcomeScreenShell animateAvatarWaveIn fillsViewport>
      <WelcomeScreenCopy error={errorMessage}>
        <Button
          type="button"
          variant="primary"
          size="regular"
          fullWidth
          className="h-11 text-base"
          onClick={handleSignIn}
          disabled={loading}
        >
          {t("loginPage.signIn")}
        </Button>
      </WelcomeScreenCopy>
    </WelcomeScreenShell>
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

  // Both builds wait inside the shell they are about to fill in, and the wait
  // is what plays the wave in. `AvatarWave` pours once per session, so a wait
  // that rendered settled would leave the entrance for the screen behind it
  // and restart the crowd the moment the probe resolved.
  if (shortCircuit.kind === "wait") {
    return (
      <WelcomeScreenShell animateAvatarWaveIn fillsViewport>
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
