import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { connectManagedOAuthProvider } from "@/lib/auth/managed-oauth";
import { managedOAuthErrorMessage } from "@/lib/auth/managed-oauth-copy";
import { t } from "@/i18n";
import type { QueryKey } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";

interface UseOAuthConnectOptions {
  assistantId: string;
  providerKey: string;
  displayName: string;
  managedAvailable: boolean;
  connectionsQueryKey: QueryKey;
}

interface UseOAuthConnectResult {
  /**
   * Start the managed OAuth flow. Pass `requestedScopes` to ask the provider
   * for a specific subset of scopes (e.g. Calendar-only for Google); omit it
   * to request the provider's full default scope set.
   */
  handleConnect: (requestedScopes?: string[]) => void;
  oauthInProgress: boolean;
}

/**
 * Settings-side entry point to the managed OAuth flow.
 *
 * The popup lifecycle, the three completion channels (postMessage, storage,
 * native deep link), the native `SFSafariViewController` path and the
 * connection reconciliation all live in `connectManagedOAuthProvider`, which
 * every entry point shares. This hook only maps the outcome onto toasts and a
 * connections-cache refresh.
 */
export function useOAuthConnect({
  assistantId,
  providerKey,
  displayName,
  managedAvailable,
  connectionsQueryKey,
}: UseOAuthConnectOptions): UseOAuthConnectResult {
  const queryClient = useQueryClient();
  const [oauthInProgress, setOAuthInProgress] = useState(false);

  // The flow outlives the modal: a detached popup can still land a completion
  // after the user navigates away, and the toast is worth showing while the
  // state update is not.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleConnect = useCallback(
    (requestedScopes: string[] = []) => {
      if (!managedAvailable) {
        return;
      }
      setOAuthInProgress(true);

      const releaseBusyState = () => {
        if (mountedRef.current) {
          setOAuthInProgress(false);
        }
      };

      void connectManagedOAuthProvider({
        assistantId,
        providerKey,
        providerLabel: displayName,
        requestedScopes,
        onDetached: releaseBusyState,
      }).then((result) => {
        releaseBusyState();

        if (result.status === "connected") {
          toast.success(
            t("useOauthConnect.accountConnected", { name: displayName }),
          );
          void queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
          return;
        }

        if (result.status === "cancelled") {
          // A detached popup that never reported back is not a cancellation we
          // can assert, so only a genuine close is surfaced as a failure.
          if (result.reason === "popup-closed") {
            toast.error(
              t("useOauthConnect.authPopupClosed", { name: displayName }),
            );
          }
          return;
        }

        toast.error(managedOAuthErrorMessage(result, displayName));
      });
    },
    [
      assistantId,
      connectionsQueryKey,
      displayName,
      managedAvailable,
      providerKey,
      queryClient,
    ],
  );

  return { handleConnect, oauthInProgress };
}
