import { resolveNavigation } from "@/lib/navigation/navigation-resolver";
import { buildNavigationState } from "@/lib/navigation/build-state";
import { routes } from "@/utils/routes";

export const PROVIDER_ID = "workos-oidc";
export const PROVIDER_CALLBACK_URL = routes.account.providerCallback;
export type AuthCallbackIntent = "login" | "signup";

const AUTH_INTENT_QUERY_PARAM = "authIntent";

export function buildProviderCallbackUrl(
  returnTo: string | null,
  options: { authIntent?: AuthCallbackIntent } = {},
): string {
  const params = new URLSearchParams();
  if (returnTo) {
    params.set("returnTo", returnTo);
  }
  if (options.authIntent) {
    params.set(AUTH_INTENT_QUERY_PARAM, options.authIntent);
  }
  const qs = params.toString();
  if (!qs) {
    return PROVIDER_CALLBACK_URL;
  }
  return `${PROVIDER_CALLBACK_URL}?${qs}`;
}

export function readAuthCallbackIntent(
  searchParams: URLSearchParams,
): AuthCallbackIntent {
  return searchParams.get(AUTH_INTENT_QUERY_PARAM) === "signup"
    ? "signup"
    : "login";
}

export function requiresFullPageNavigation(destination: string): boolean {
  return (
    destination.startsWith("http") ||
    destination.startsWith("/accounts/") ||
    destination.startsWith("/v1/") ||
    destination.startsWith("/_allauth/")
  );
}

export function resolvePostLoginDestination(
  returnTo: string | null,
  fallback: string,
): {
  destination: string;
  requiresFullPageNavigation: boolean;
} {
  return resolvePostAuthDestination({ returnTo, fallback, authIntent: "login" });
}

export function resolvePostAuthDestination({
  returnTo,
  fallback,
  authIntent,
}: {
  returnTo: string | null;
  fallback: string;
  authIntent: AuthCallbackIntent;
}): {
  destination: string;
  requiresFullPageNavigation: boolean;
} {
  const decision = resolveNavigation(buildNavigationState(), {
    kind: "post-auth",
    authIntent,
    returnTo,
    fallback,
  });
  const destination = decision.action === "redirect" ? decision.to : fallback;
  return {
    destination,
    requiresFullPageNavigation: requiresFullPageNavigation(destination),
  };
}
