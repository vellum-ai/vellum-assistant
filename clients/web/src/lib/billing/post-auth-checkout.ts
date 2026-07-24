import {
  clearCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";
import { routes } from "@/utils/routes";

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
  return { isCheckout: true, packageKey: url.searchParams.get("package") || null };
}

/**
 * The `package` slug of a deep-link checkout destination
 * (`/assistant/checkout?package=`), or null when the destination is not a
 * checkout link or carries no package.
 */
export function checkoutPackageFromDestination(destination: string): string | null {
  return parseCheckoutDestination(destination).packageKey;
}

export interface SignupCheckoutResolution {
  /** Where the auth should land. */
  destination: string;
  /** The package stashed for post-consent checkout resume, or null. */
  stashedPackage: string | null;
}

/**
 * The shared post-auth checkout decision for both the web
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
}): SignupCheckoutResolution {
  const { intent, returnTo } = args;
  const { isCheckout, packageKey } = parseCheckoutDestination(returnTo);

  if (!isCheckout) {
    clearCheckoutIntent();
  }

  if (intent === "signup") {
    if (packageKey) {
      saveCheckoutIntent({ kind: "package", packageKey });
    }
    return { destination: routes.onboarding.privacy, stashedPackage: packageKey };
  }

  return { destination: returnTo, stashedPackage: null };
}
