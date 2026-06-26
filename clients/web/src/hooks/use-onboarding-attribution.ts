/**
 * Captures the onboarding deep-link attribution param on a landing page and
 * reports it as a research-onboarding funnel event.
 *
 * The Day-2 check-in calendar event's CTA links back into the app carrying a
 * custom `vref` param (see `assistant/src/onboarding/checkin-event.ts`). The
 * marketing-site UTM capture never sees `/assistant/*` routes, so the app reads
 * the param itself, emits the funnel step (→ `/v1/telemetry/ingest/` → BigQuery,
 * same path as every other onboarding event), and strips the param so a refresh
 * can't double-count and the address bar stays clean.
 *
 * Lives in the top-level `hooks/` dir (not `domains/chat/`) so the chat surface
 * that calls it doesn't take a cross-domain dependency on onboarding internals.
 *
 * Fires once, and only after auth resolves a user id so the event isn't
 * attributed to a null user — these are authenticated routes, so waiting costs
 * nothing.
 */

import { useEffect, useRef } from "react";

import type { SetURLSearchParams } from "react-router";

import {
  ONBOARDING_ATTRIBUTION_PARAM,
  RESEARCH_CHECKIN_CALENDAR_ATTRIBUTION,
  emitResearchOnboardingCheckinCalendarOpened,
} from "@/domains/onboarding/funnel-events";

export interface UseOnboardingAttributionOptions {
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  /** Resolved user id, or null while auth is still settling. */
  userId: string | null;
}

export function useOnboardingAttribution({
  searchParams,
  setSearchParams,
  userId,
}: UseOnboardingAttributionOptions): void {
  const consumedRef = useRef(false);
  useEffect(() => {
    if (consumedRef.current) return;
    if (
      searchParams.get(ONBOARDING_ATTRIBUTION_PARAM) !==
      RESEARCH_CHECKIN_CALENDAR_ATTRIBUTION
    ) {
      return;
    }
    // Wait for auth so the event carries the real user id; harmless to defer.
    if (!userId) return;

    consumedRef.current = true;
    emitResearchOnboardingCheckinCalendarOpened({ userId });

    // Drop just the tracking param, preserving everything else (e.g. the
    // `prompt` the auto-send path still consumes).
    setSearchParams(
      (prev) => {
        prev.delete(ONBOARDING_ATTRIBUTION_PARAM);
        return prev;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams, userId]);
}
