import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Mail } from "lucide-react";

import { Button } from "@vellum/design-library";
import { AppleLogo } from "@/components/icons/apple-logo.js";
import { GoogleLogo } from "@/components/icons/google-logo.js";
import { NativeSplash } from "@/components/native-splash.js";
import { LoginBackground } from "@/domains/account/components/login-background.js";
import { PROVIDER_ID, buildProviderCallbackUrl } from "@/domains/account/login-flow.js";
import {
  startAuthFlow,
  startNativeLogin,
  useIsNativePlatform,
} from "@/runtime/native-auth.js";
import { routes } from "@/utils/routes.js";

const CARD_CLASS =
  "flex w-full max-w-[448px] flex-col gap-6 rounded-lg border border-[var(--border-disabled)] bg-[var(--surface-lift)] p-6";

function SignUpFooter({ signUpHref }: { signUpHref: string }) {
  return (
    <p className="text-body-small-default flex justify-center gap-1">
      <span className="text-[var(--content-secondary)]">
        Don&apos;t have an account?
      </span>
      <Link
        to={signUpHref}
        className="font-medium text-[var(--content-emphasised)] hover:underline"
      >
        Sign up
      </Link>
    </p>
  );
}

function LoginCard({ children }: { children: ReactNode }) {
  return <div className={CARD_CLASS}>{children}</div>;
}

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  signup_closed: "Sign-ups are currently closed. Please contact support.",
};

/**
 * Capacitor iOS login: single "Sign in" button inside NativeSplash.
 * Opens a Safari sheet via `/accounts/native/start` with no provider
 * hint — WorkOS AuthKit handles Apple / Google / email selection.
 */
function NativeLoginForm({ returnTo }: { returnTo: string | null }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const triggerAuth = async () => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await startNativeLogin({ returnTo: returnTo ?? null });
    } catch (err) {
      const errorCode = (err as { code?: unknown } | null | undefined)?.code;
      if (errorCode === "USER_CANCELLED") {
        setLoading(false);
        return;
      }
      if (errorCode === "AUTH_ERROR") {
        const errorKey =
          (err as { data?: Record<string, unknown> }).data?.authError as string | undefined;
        setErrorMessage(
          (errorKey && AUTH_ERROR_MESSAGES[errorKey]) ?? "Something went wrong. Please try again.",
        );
      } else {
        console.error("[native-auth] auth flow failed:", err);
        setErrorMessage("Something went wrong. Please try again.");
      }
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
          <p className="text-body-small-default max-w-[280px] text-center text-[var(--system-negative-strong)]">
            {errorMessage}
          </p>
        )}
        <Button
          type="button"
          variant="primary"
          fullWidth
          onClick={handleSignIn}
          disabled={loading}
          className="max-w-[300px]"
        >
          Sign in
        </Button>
      </div>
    </NativeSplash>
  );
}

/**
 * Web login form: three equal sign-in buttons routing through WorkOS.
 * 1. Continue with Apple → `provider_hint=AppleOAuth` (top, per Apple HIG).
 * 2. Continue with Google → `provider_hint=GoogleOAuth`.
 * 3. Continue with Email → no hint, opens WorkOS AuthKit email/password UI.
 *
 * Wraps itself in a forced-dark theme context with the branded
 * `LoginBackground` — the web login screen is always dark per Figma.
 */
function WebLoginForm({ returnTo }: { returnTo: string | null }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const callbackUrl = buildProviderCallbackUrl(returnTo);
  const signUpHref = returnTo
    ? `${routes.account.signup}?returnTo=${encodeURIComponent(returnTo)}`
    : routes.account.signup;

  const handleProvider = async (providerHint?: string) => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await startAuthFlow(PROVIDER_ID, callbackUrl, {
        ...(providerHint ? { providerHint } : {}),
        returnTo,
      });
    } catch (err) {
      console.error("[web-login] auth flow failed:", err);
      setErrorMessage("Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  const handleApple = () => void handleProvider("AppleOAuth");
  const handleGoogle = () => void handleProvider("GoogleOAuth");
  const handleEmail = () => void handleProvider();

  return (
    <div className="dark">
      <div className="relative min-h-screen overflow-x-hidden bg-[var(--surface-base)] text-[var(--content-default)]">
        <LoginBackground />
        <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4">
          <LoginCard>
            <h1 className="text-title-large text-center text-[var(--content-emphasised)]">
              Sign in to Vellum
            </h1>
            {errorMessage && (
              <p className="text-body-small-default text-center text-[var(--system-negative-strong)]">
                {errorMessage}
              </p>
            )}
            <div className="flex flex-col items-center gap-3">
              <Button
                type="button"
                variant="outlined"
                fullWidth
                onClick={handleApple}
                disabled={loading}
                leftIcon={<AppleLogo />}
                className="max-w-[300px] gap-3"
              >
                Continue with Apple
              </Button>
              <Button
                type="button"
                variant="outlined"
                fullWidth
                onClick={handleGoogle}
                disabled={loading}
                leftIcon={<GoogleLogo />}
                className="max-w-[300px] gap-3"
              >
                Continue with Google
              </Button>
              <Button
                type="button"
                variant="outlined"
                fullWidth
                onClick={handleEmail}
                disabled={loading}
                leftIcon={<Mail />}
                className="max-w-[300px] gap-3"
              >
                Continue with Email
              </Button>
            </div>
            <SignUpFooter signUpHref={signUpHref} />
          </LoginCard>
        </div>
      </div>
    </div>
  );
}

/**
 * Branded sign-in screen for `/account/login`.
 *
 * Delegates to `NativeLoginForm` (Capacitor iOS) or `WebLoginForm`
 * (standard browser) based on platform detection.
 */
export function LoginPage() {
  const [searchParams] = useSearchParams();
  const isNative = useIsNativePlatform();
  const returnTo = searchParams.get("returnTo");

  if (isNative) return <NativeLoginForm returnTo={returnTo} />;
  return <WebLoginForm returnTo={returnTo} />;
}
