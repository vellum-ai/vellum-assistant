import { useState } from "react";
import { useSearchParams } from "react-router";

import { NativeSplash } from "@/components/native-splash";
import { DarkLoginShell, LoginCard, LoginErrorText, LoginHeading } from "@/domains/account/components/login-shell";
import { PROVIDER_ID, buildProviderCallbackUrl } from "@/domains/account/login-flow";
import { startAuthFlow, startNativeLogin, useIsNativePlatform } from "@/runtime/native-auth";
import { Button } from "@vellumai/design-library";

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  signup_closed:
    "Sign-ups are currently closed. Visit vellum.ai/community to request access.",
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
      const errorCode =
        err && typeof err === "object" && "code" in err ? err.code : undefined;
      if (errorCode === "USER_CANCELLED") {
        setLoading(false);
        return;
      }
      if (errorCode === "AUTH_ERROR") {
        const errorKey =
          err &&
          typeof err === "object" &&
          "data" in err &&
          err.data &&
          typeof err.data === "object" &&
          "authError" in err.data &&
          typeof err.data.authError === "string"
            ? err.data.authError
            : undefined;
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
          <LoginErrorText className="max-w-[280px]">{errorMessage}</LoginErrorText>
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
 * Web / Electron login: a single CTA that hands off to WorkOS AuthKit (which
 * hosts the provider + email/password selection). Wrapped in a forced-dark
 * theme context (the web login screen is always dark per Figma).
 */
function WebLoginForm({ returnTo }: { returnTo: string | null }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const callbackUrl = buildProviderCallbackUrl(returnTo);

  const handleContinue = async () => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await startAuthFlow(PROVIDER_ID, callbackUrl, { returnTo });
    } catch (err) {
      console.error("[web-login] auth flow failed:", err);
      setErrorMessage("Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  return (
    <DarkLoginShell>
      <LoginCard>
        <LoginHeading>Sign in to Vellum</LoginHeading>
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
            Continue
          </Button>
        </div>
      </LoginCard>
    </DarkLoginShell>
  );
}

/**
 * Branded sign-in screen for `/account/login`.
 *
 * Delegates to `NativeLoginForm` (Capacitor iOS) or `WebLoginForm`
 * (standard browser / Electron) based on platform detection.
 */
export function LoginPage() {
  const [searchParams] = useSearchParams();
  const isNative = useIsNativePlatform();
  const returnTo = searchParams.get("returnTo");

  if (isNative) return <NativeLoginForm returnTo={returnTo} />;
  return <WebLoginForm returnTo={returnTo} />;
}
