import { AuthWaitSpinner } from "@/domains/account/components/auth-wait-spinner";
import { SignupScreen } from "@/domains/account/components/signup-screen";
import { SignupShell } from "@/domains/account/components/signup-shell";
import { useFunnelPageView } from "@/domains/account/hooks/use-funnel-page-view";
import { useReturnToShortCircuit } from "@/domains/account/hooks/use-return-to-short-circuit";
import { routes } from "@/utils/routes";

/**
 * Signup entry. Renders the branded sign-up screen for everyone: a rotating
 * headline with Google / Apple / Email buttons. Each button hands off to the
 * WorkOS auth flow (`intent: "signup"`); the post-OAuth name/occupation step
 * lives in `ProviderSignupPage`.
 *
 * `useReturnToShortCircuit` owns whether an existing session skips OAuth and
 * lands on the `returnTo` destination directly — the same decision
 * `LoginPage` makes. Only the loading shell differs.
 */
export function SignupPage() {
  const shortCircuit = useReturnToShortCircuit();
  // Only a visitor who reaches the screen is a funnel arrival — an existing
  // session that short-circuits straight to `returnTo` is not.
  useFunnelPageView(routes.account.signup, shortCircuit.kind === "proceed");

  if (shortCircuit.kind === "wait") {
    return (
      <SignupShell>
        <AuthWaitSpinner />
      </SignupShell>
    );
  }
  if (shortCircuit.kind === "redirect") {
    return shortCircuit.node;
  }

  return <SignupScreen returnTo={shortCircuit.returnTo} />;
}
