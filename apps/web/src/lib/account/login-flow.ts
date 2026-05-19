import { sanitizeReturnTo } from "@/lib/account/return-to.js";
import { BASENAME, routes } from "@/utils/routes.js";

export const PROVIDER_ID = "workos-oidc";

/**
 * Full browser path for the OAuth callback. Must include BASENAME because
 * this value is resolved to an absolute URL via `new URL(callbackUrl, origin)`
 * in `buildProviderRedirectFields` — React Router's basename is not involved.
 */
export const PROVIDER_CALLBACK_URL = `${BASENAME}${routes.account.providerCallback}`;

export function buildLoginRedirectUrl(
  pathname: string,
  searchParams: URLSearchParams,
): string {
  const qs = searchParams.toString();
  const fullPath = qs ? `${pathname}?${qs}` : pathname;
  return `${routes.account.login}?returnTo=${encodeURIComponent(fullPath)}`;
}

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

/**
 * Resolve the post-login destination from a returnTo parameter.
 *
 * When the destination is a same-origin path intended for React Router's
 * `navigate()`, the BASENAME prefix is stripped so the router doesn't
 * double-prefix it (React Router applies the basename automatically).
 * Full-page navigations (`window.location.href`) keep the original value.
 */
export function resolvePostLoginDestination(
  returnTo: string | null,
  fallback: string,
): {
  destination: string;
  requiresFullPageNavigation: boolean;
} {
  const raw = sanitizeReturnTo(returnTo, fallback);
  const fullPage = requiresFullPageNavigation(raw);
  const destination = !fullPage && raw.startsWith(BASENAME)
    ? raw.slice(BASENAME.length) || "/"
    : raw;
  return { destination, requiresFullPageNavigation: fullPage };
}
