import { Link } from "react-router";
import { Mail } from "lucide-react";

import { Button } from "@vellum/design-library";

import { AppleLogo } from "@/components/icons/apple-logo";
import { GoogleLogo } from "@/components/icons/google-logo";
import { LoginErrorText, LoginHeading } from "@/domains/account/components/login-shell";
import { routes } from "@/utils/routes";

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

/**
 * Apple / Google / Email sign-in buttons routing through WorkOS.
 * Shared by the standalone web login and the local-mode login's platform card.
 */
export function PlatformLoginButtons({
  returnTo,
  loading,
  errorMessage,
  onProviderClick,
}: {
  returnTo: string | null;
  loading: boolean;
  errorMessage: string | null;
  onProviderClick: (providerHint?: string) => void;
}) {
  const signUpHref = returnTo
    ? `${routes.account.signup}?returnTo=${encodeURIComponent(returnTo)}`
    : routes.account.signup;

  return (
    <>
      <LoginHeading>Sign in to Vellum</LoginHeading>
      {errorMessage && <LoginErrorText>{errorMessage}</LoginErrorText>}
      <div className="flex flex-col items-center gap-3">
        <Button
          type="button"
          variant="outlined"
          fullWidth
          onClick={() => onProviderClick("AppleOAuth")}
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
          onClick={() => onProviderClick("GoogleOAuth")}
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
          onClick={() => onProviderClick()}
          disabled={loading}
          leftIcon={<Mail />}
          className="max-w-[300px] gap-3"
        >
          Continue with Email
        </Button>
      </div>
      <SignUpFooter signUpHref={signUpHref} />
    </>
  );
}
