/**
 * Managed Google OAuth connect for the check-in onboarding page.
 *
 * SPIKE: checkin-onboarding flow.
 *
 * Parameterized with `requestedScopes` (so the check-in page can ask for ONLY
 * `calendar.events`, the minimum to create an event, instead of the full
 * Gmail+Calendar+Drive bundle) and an `onConnect(scopes)` callback.
 *
 * The popup lifecycle, the three completion channels (postMessage, storage,
 * native deep link), the native `SFSafariViewController` path and the
 * connection reconciliation all live in `connectManagedOAuthProvider`, which
 * every entry point shares.
 */

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";
import { useCallback, useEffect, useRef, useState } from "react";

import { connectManagedOAuthProvider } from "@/lib/auth/managed-oauth";
import { managedOAuthErrorMessage } from "@/lib/auth/managed-oauth-copy";
import { assistantsOauthConnectionsListQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import { t } from "@/i18n";
import { resolveLocalAssistantPlatformIdentity } from "@/lib/local-platform-identity";

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
  oauthInProgress: boolean;
}

export function useGoogleCalendarConnect({
  assistantId,
  requestedScopes = GOOGLE_CALENDAR_CONNECT_SCOPES,
  onConnect,
}: UseGoogleCalendarConnectOptions): UseGoogleCalendarConnectResult {
  const queryClient = useQueryClient();
  const [oauthInProgress, setOAuthInProgress] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleConnect = useCallback(() => {
    setOAuthInProgress(true);
    const providerLabel = t("googleCalendar.providerLabel", {
      ns: "onboarding",
    });

    const releaseBusyState = () => {
      if (mountedRef.current) {
        setOAuthInProgress(false);
      }
    };

    void connectManagedOAuthProvider({
      assistantId,
      providerKey: GOOGLE_PROVIDER_KEY,
      providerLabel,
      requestedScopes,
      onDetached: releaseBusyState,
    }).then((result) => {
      releaseBusyState();

      if (result.status === "connected") {
        // Refresh the connections cache the onboarding screens read. Safe after
        // unmount: it only marks a query stale.
        void resolveLocalAssistantPlatformIdentity(assistantId)
          .then((platformAssistantId) =>
            queryClient.invalidateQueries({
              queryKey: assistantsOauthConnectionsListQueryKey({
                path: { assistant_id: platformAssistantId },
              }),
            }),
          )
          .catch(() => {});
        // The engine now outlives this screen (a detached flow stays armed for
        // minutes), so a late completion can arrive after the user moved on
        // through the top nav. `onConnect` schedules the check-in and
        // navigates, which would drag them back; only run it while mounted.
        if (mountedRef.current) {
          onConnect(result.connection?.scopes_granted ?? []);
        }
        return;
      }

      // A cancelled connect is the user's own choice; onboarding stays quiet
      // and leaves the button ready for another try.
      if (result.status === "error" && mountedRef.current) {
        toast.error(managedOAuthErrorMessage(result, providerLabel));
      }
    });
  }, [assistantId, onConnect, queryClient, requestedScopes]);

  return { handleConnect, oauthInProgress };
}
