import { useSearchParams } from "react-router";

import { ReturnToRedirect } from "@/domains/account/components/return-to-redirect";
import { SignupScreen } from "@/domains/account/components/signup-screen";
import { SignupShell } from "@/domains/account/components/signup-shell";
import { sanitizeReturnTo } from "@/domains/account/return-to";
import {
  useIsAuthenticated,
  useIsSessionInitializing,
} from "@/stores/auth-store";
import { routes } from "@/utils/routes";

/**
 * Signup entry. Renders the branded sign-up screen for everyone: a rotating
 * headline with Google / Apple / Email buttons. Each button hands off to the
 * WorkOS auth flow (`intent: "signup"`); the post-OAuth name/occupation step
 * lives in `ProviderSignupPage`.
 *
 * A `returnTo` means something sent the visitor here on the way somewhere
 * specific (e.g. a marketing pricing CTA), so an existing session skips OAuth
 * and lands there directly. A bare visit always gets the sign-up screen — a
 * signed-in visitor may be there to create another account.
 */
export function SignupPage() {
  const [searchParams] = useSearchParams();
  const isAuthenticated = useIsAuthenticated();
  const isSessionInitializing = useIsSessionInitializing();
  const rawReturnTo = searchParams.get("returnTo");
  const destination = sanitizeReturnTo(rawReturnTo, routes.assistant);

  if (rawReturnTo) {
    if (isSessionInitializing) return <SignupShell>{null}</SignupShell>;
    if (isAuthenticated) return <ReturnToRedirect to={destination} />;
  }

  return <SignupScreen returnTo={rawReturnTo ? destination : null} />;
}
