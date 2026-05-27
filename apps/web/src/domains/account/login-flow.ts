import { sanitizeReturnTo } from "@/domains/account/return-to";
import { routes } from "@/utils/routes";

export const PROVIDER_ID = "workos-oidc";
export const PROVIDER_CALLBACK_URL = routes.account.providerCallback;

export function buildProviderCallbackUrl(returnTo: string | null): string {
  if (!returnTo) {
    return PROVIDER_CALLBACK_URL;
  }
  return `${PROVIDER_CALLBACK_URL}?returnTo=${encodeURIComponent(returnTo)}`;
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
  const destination = sanitizeReturnTo(returnTo, fallback);
  return {
    destination,
    requiresFullPageNavigation: requiresFullPageNavigation(destination),
  };
}
