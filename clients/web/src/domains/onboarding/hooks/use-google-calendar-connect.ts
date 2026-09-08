/**
 * Managed Google OAuth connect for the check-in onboarding page.
 *
 * SPIKE: checkin-onboarding flow.
 *
 * Parameterized with `requestedScopes` (so the check-in page can ask for ONLY
 * `calendar.events`, the minimum to create an event, instead of the full
 * Gmail+Calendar+Drive bundle) and an `onConnect(scopes)` callback.
 *
 * The connect flow itself lives in `useManagedOAuthConnect`, which every entry
 * point shares. This hook adds only what the check-in page needs: a narrowed
 * scope set and a callback carrying the scopes actually granted.
 */

import { toast } from "@vellumai/design-library/components/toast";
import { useEffect, useRef } from "react";

import { useManagedOAuthConnect } from "@/hooks/use-managed-oauth-connect";
import { t } from "@/i18n";

const GOOGLE_PROVIDER_KEY = "google";

/** Minimum Google scope needed to create a calendar event (read/write events). */
export const GOOGLE_CALENDAR_EVENTS_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

/**
 * Identity scopes required for the managed OAuth flow to finalize a connection.
 * Without them the platform can't resolve the Google account (no access to the
 * userinfo endpoint / id token) and the grant fails with `identity_failed`, so
 * no connection row is created. These are part of the managed app's default scope
 * set, which is why the full-bundle connect works; a calendar-only override
 * drops them. Cheap from a consent standpoint (email + basic identity) and
 * still far narrower than Gmail/Drive.
 */
const GOOGLE_IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

/**
 * The minimal working scope set for the check-in connect: account identity plus
 * calendar-event read/write. No Gmail, no Drive, no full-calendar read.
 */
export const GOOGLE_CALENDAR_CONNECT_SCOPES = [
  ...GOOGLE_IDENTITY_SCOPES,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
];

interface UseGoogleCalendarConnectOptions {
  assistantId: string;
  /** Scopes to request. Defaults to identity + calendar-events (the minimum
   *  that produces a working managed connection). */
  requestedScopes?: string[];
  /** Called with the scopes actually granted once the connection lands. */
  onConnect: (scopes: string[]) => void;
}

interface UseGoogleCalendarConnectResult {
  handleConnect: () => void;
  /**
   * Abandon an authorization in progress. The window cannot be observed, so
   * this is the only way an attempt ends short of completing.
   */
  cancelConnect: () => void;
  oauthInProgress: boolean;
}

export function useGoogleCalendarConnect({
  assistantId,
  requestedScopes = GOOGLE_CALENDAR_CONNECT_SCOPES,
  onConnect,
}: UseGoogleCalendarConnectOptions): UseGoogleCalendarConnectResult {
  const providerLabel = t("googleCalendar.providerLabel", { ns: "onboarding" });
  const connect = useManagedOAuthConnect({
    assistantId,
    providerKey: GOOGLE_PROVIDER_KEY,
    providerLabel,
    requestedScopes,
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A connection can land after the user has moved on through the top nav,
  // and `onConnect` schedules the check-in and navigates, so it runs only
  // while this screen is mounted.
  const { status, connection, errorMessage } = connect;
  useEffect(() => {
    if (status === "connected" && mountedRef.current) {
      onConnect(connection?.scopes_granted ?? []);
    }
  }, [connection, onConnect, status]);

  useEffect(() => {
    if (errorMessage && mountedRef.current) {
      toast.error(errorMessage);
    }
  }, [errorMessage]);

  return {
    handleConnect: connect.connect,
    cancelConnect: connect.dismiss,
    oauthInProgress: status === "attempting",
  };
}
