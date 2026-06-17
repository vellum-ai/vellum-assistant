import { routes } from "@/utils/routes";

const ONBOARDING_PREFIX = `${routes.assistant}/onboarding`;

const STATUS_BANNER_SETUP_PATHS: ReadonlySet<string> = new Set([
  routes.welcome,
  routes.selectAssistant,
  routes.reviewTerms,
]);

export function shouldSuppressRootStatusBanner(
  pathname: string,
  search: string,
): boolean {
  if (
    pathname === ONBOARDING_PREFIX ||
    pathname.startsWith(`${ONBOARDING_PREFIX}/`) ||
    STATUS_BANNER_SETUP_PATHS.has(pathname)
  ) {
    return true;
  }

  return new URLSearchParams(search).get("onboarding") === "1";
}
