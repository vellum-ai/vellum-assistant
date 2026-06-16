import { useSearchParams } from "react-router";

import { SignupScreen } from "@/domains/account/components/signup-screen";

/**
 * Signup entry. Renders the branded sign-up screen for everyone: a rotating
 * headline with Google / Apple / Email buttons. Each button hands off to the
 * WorkOS auth flow (`intent: "signup"`); the post-OAuth name/occupation step
 * lives in `ProviderSignupPage`.
 */
export function SignupPage() {
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");

  return <SignupScreen returnTo={returnTo} />;
}
