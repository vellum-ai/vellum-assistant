import { routes } from "@/utils/routes";

/**
 * Query param that asks the hatch screen to hand off to chat instead of the
 * research/personality funnel. Set only by the non-production "Skip to chat"
 * control on the privacy screen (and carried through checkout / paid-return
 * resumptions of that click). Production builds ignore it.
 */
export const SKIP_RESEARCH_PARAM = "skip_research";

/**
 * Whether this build may skip the research/personality funnel after consent.
 * True everywhere except a production `VITE_SENTRY_ENVIRONMENT` so local, dev,
 * and staging can drop into chat without walking the research steps.
 */
export function canSkipOnboardingResearch(
  env: string | undefined = import.meta.env.VITE_SENTRY_ENVIRONMENT,
): boolean {
  return env !== "production";
}

/**
 * Whether a hatch completion should skip research and enter chat. Requires both
 * the skip query param and a non-production build, so a crafted production URL
 * cannot bypass the funnel.
 */
export function shouldSkipResearchAfterHatch(
  searchParams: Pick<URLSearchParams, "get">,
  env: string | undefined = import.meta.env.VITE_SENTRY_ENVIRONMENT,
): boolean {
  return (
    canSkipOnboardingResearch(env) &&
    searchParams.get(SKIP_RESEARCH_PARAM) === "1"
  );
}

/**
 * Mark a post-consent destination so the hatch screen hands off to chat
 * instead of research. No-op on production builds.
 *
 * Research URLs are rewritten to hatching: skip has no form to fill, so the
 * foreground hatch screen is the provisioner.
 */
export function withSkipResearch(
  destination: string,
  env: string | undefined = import.meta.env.VITE_SENTRY_ENVIRONMENT,
): string {
  if (!canSkipOnboardingResearch(env)) {
    return destination;
  }
  const qIdx = destination.indexOf("?");
  const path = qIdx < 0 ? destination : destination.slice(0, qIdx);
  const params = new URLSearchParams(
    qIdx < 0 ? "" : destination.slice(qIdx + 1),
  );
  params.set(SKIP_RESEARCH_PARAM, "1");
  const nextPath =
    path === routes.onboarding.research ? routes.onboarding.hatching : path;
  return `${nextPath}?${params.toString()}`;
}

/**
 * Decide where the standard onboarding flow goes after the user accepts
 * consent on the privacy screen.
 *
 * The research/personality flow is now THE onboarding, but HOW the assistant is
 * provisioned differs by hosting:
 *
 * - **Platform / Vellum-Cloud** → straight to `/assistant/onboarding/research`,
 *   which runs its own managed background hatch and walks the user to chat.
 * - **Local hosting** (`hosting=local`/`docker` in a local-mode build) → the
 *   `hatching` screen first, so the FOREGROUND local hatch (daemon spawn →
 *   gateway readyz → provider key) runs; the hatching screen then redirects into
 *   the research flow, which adopts that just-hatched assistant. Skipping
 *   hatching here would leave the research flow with no assistant to adopt.
 * - **Already onboarded** (hatched at least a week ago) → `/assistant`. The
 *   assistant is already provisioned and past research, including in
 *   production.
 * - **Skip to chat** (non-production) → hatching as well. There is no research
 *   form, so the hatch screen provisions, then hands off to chat.
 */
export function onboardingDestinationAfterConsent({
  isLocalHatch,
  skipResearch = false,
  alreadyOnboarded = false,
  env = import.meta.env.VITE_SENTRY_ENVIRONMENT,
}: {
  /** A local-hosting onboarding that must run the foreground local hatch. */
  isLocalHatch: boolean;
  /**
   * Non-production shortcut past the research/personality funnel. Ignored on
   * production builds.
   */
  skipResearch?: boolean;
  /**
   * The current assistant has already finished first-run onboarding. Skips
   * research on every build, including production.
   */
  alreadyOnboarded?: boolean;
  /** Build environment; defaults to `VITE_SENTRY_ENVIRONMENT`. */
  env?: string;
}): string {
  if (alreadyOnboarded) {
    return routes.assistant;
  }
  if (skipResearch && canSkipOnboardingResearch(env)) {
    return routes.onboarding.hatching;
  }
  return isLocalHatch
    ? routes.onboarding.hatching
    : routes.onboarding.research;
}
