import {
  clearCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";
import { PACKAGE_PARAM, routes } from "@/utils/routes";

/**
 * Whether a destination is the `/assistant/checkout` deep link, plus the
 * `package` slug it carries (null when absent). The marketing pricing CTAs
 * point here to start Stripe checkout for a chosen package.
 */
function parseCheckoutDestination(destination: string): {
  isCheckout: boolean;
  packageKey: string | null;
} {
  let url: URL;
  try {
    url = new URL(destination, "http://placeholder.invalid");
  } catch {
    return { isCheckout: false, packageKey: null };
  }
  if (url.pathname !== routes.checkout) {
    return { isCheckout: false, packageKey: null };
  }
  return {
    isCheckout: true,
    packageKey: url.searchParams.get(PACKAGE_PARAM) || null,
  };
}

/**
 * The shared post-auth checkout destination for both the web
 * (`resolvePostAuth`) and native (`resolveNativePostAuthDestination`) paths.
 *
 * A signup that carries a pricing-CTA checkout deep link stashes the package
 * and routes through consent (privacy) first, so the consent screen resumes
 * checkout after onboarding. Any auth that is NOT a checkout deep link
 * discards a stale stash left by an abandoned earlier attempt — external OAuth
 * can't run a cleanup callback, so the next auth entry self-cleans; the stash
 * this flow sets is never touched. A signup otherwise routes to privacy; a
 * login keeps its own `returnTo` and starts checkout directly from there.
 */
export function resolveSignupCheckoutDestination(args: {
  intent: "login" | "signup";
  returnTo: string;
}): string {
  const { intent, returnTo } = args;
  const { isCheckout, packageKey } = parseCheckoutDestination(returnTo);

  if (!isCheckout) {
    clearCheckoutIntent();
  }

  if (intent === "signup") {
    if (packageKey) {
      // Mark the stash as signup-originated so only the onboarding privacy
      // screen resumes it — an ordinary billing-surface stash stays inert here.
      saveCheckoutIntent({
        kind: "package",
        packageKey,
        resumeAfterOnboarding: true,
      });
    }
    return routes.onboarding.privacy;
  }

  return returnTo;
}
