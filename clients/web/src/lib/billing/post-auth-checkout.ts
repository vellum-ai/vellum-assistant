import {
  clearCheckoutIntent,
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";
import {
  parseCustomCheckoutSelection,
  type CustomCheckoutSelection,
} from "@/lib/billing/custom-checkout-params";
import { PACKAGE_PARAM, routes } from "@/utils/routes";

/** What a checkout deep link asks to buy. */
type CheckoutDestination =
  | { kind: "package"; packageKey: string }
  | { kind: "custom"; selection: CustomCheckoutSelection };

/**
 * What the destination checks out, or `null` when it is not the
 * `/assistant/checkout` deep link or names nothing that route could act on.
 * The marketing pricing CTAs point here with either `?package=<slug>` or the
 * per-dimension tier params of a custom configuration; an explicit package
 * wins, mirroring the mutual exclusion the upgrade serializer enforces on the
 * body they turn into.
 */
function parseCheckoutDestination(
  destination: string,
): CheckoutDestination | null {
  let url: URL;
  try {
    url = new URL(destination, "http://placeholder.invalid");
  } catch {
    return null;
  }
  if (url.pathname !== routes.checkout) {
    return null;
  }
  const packageKey = url.searchParams.get(PACKAGE_PARAM) || null;
  if (packageKey) {
    return { kind: "package", packageKey };
  }
  const selection = parseCustomCheckoutSelection(url.searchParams);
  return selection ? { kind: "custom", selection } : null;
}

/**
 * The shared post-auth checkout destination for both the web
 * (`resolvePostAuth`) and native (`resolveNativePostAuthDestination`) paths.
 *
 * A signup that carries a pricing-CTA checkout deep link stashes the plan it
 * names (a package slug or a custom tier configuration) and routes through
 * consent (privacy) first, so the consent screen resumes checkout after
 * onboarding. Any auth that names no checkoutable plan discards a stale stash
 * left by an abandoned earlier attempt: external OAuth can't run a cleanup
 * callback, so the next auth entry self-cleans; the stash this flow sets is
 * never touched. A signup otherwise routes to privacy; a login keeps its own
 * `returnTo` and starts checkout directly from there.
 */
export function resolveSignupCheckoutDestination(args: {
  intent: "login" | "signup";
  returnTo: string;
}): string {
  const { intent, returnTo } = args;
  const checkout = parseCheckoutDestination(returnTo);

  if (!checkout) {
    clearCheckoutIntent();
  }

  if (intent === "signup") {
    if (checkout) {
      // Mark the stash as signup-originated so only the onboarding privacy
      // screen resumes it: an ordinary billing-surface stash stays inert here.
      saveCheckoutIntent(
        checkout.kind === "package"
          ? {
              kind: "package",
              packageKey: checkout.packageKey,
              resumeAfterOnboarding: true,
            }
          : {
              kind: "custom",
              machineTier: checkout.selection.machineTier,
              storageTier: checkout.selection.storageTier,
              creditTier: checkout.selection.creditTier,
              resumeAfterOnboarding: true,
            },
      );
    }
    return routes.onboarding.privacy;
  }

  return returnTo;
}
