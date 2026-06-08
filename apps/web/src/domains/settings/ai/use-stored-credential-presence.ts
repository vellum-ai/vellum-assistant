import { useEffect, useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { secretsReadPost } from "@/generated/daemon/sdk.gen";
import { ApiError, assertHasResponse, extractErrorMessage } from "@/utils/api-errors";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import { captureError } from "@/lib/sentry/capture-error";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

// ---------------------------------------------------------------------------
// Query key
// ---------------------------------------------------------------------------

const STORED_CREDENTIAL_PRESENCE_QK = "stored-credential-presence" as const;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseStoredCredentialPresenceOptions {
  assistantId: string | undefined;
  /** Credential kind sent to the daemon (e.g. "api_key", "credential"). */
  credentialKind: string;
  /** Credential identifier sent to the daemon (e.g. "tavily", "anthropic:api_key"). */
  credentialName: string;
  /** Extra guard — the query only fires when all conditions are true. */
  enabled?: boolean;
  /** Sentry context tag for error reporting. */
  errorContext: string;
}

/**
 * Checks whether a stored credential exists on the daemon.
 *
 * Wraps `secretsReadPost` in a TanStack Query hook with org-readiness
 * gating, retry logic for transient daemon errors, and Sentry reporting
 * for persistent failures.
 */
export function useStoredCredentialPresence({
  assistantId,
  credentialKind,
  credentialName,
  enabled = true,
  errorContext,
}: UseStoredCredentialPresenceOptions) {
  const isOrgReady = useIsOrgReady();

  const queryKey = useMemo(
    () => [STORED_CREDENTIAL_PRESENCE_QK, assistantId ?? "", credentialKind, credentialName] as const,
    [assistantId, credentialKind, credentialName],
  );

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error, response } = await secretsReadPost({
        path: { assistant_id: assistantId! },
        body: { type: credentialKind, name: credentialName },
        throwOnError: false,
      });
      assertHasResponse(response, error, "Failed to check stored credential");
      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(
            error,
            response,
            `Failed to check stored credential (HTTP ${response.status})`,
          ),
        );
      }
      return data!.found;
    },
    enabled: !!assistantId && enabled && isOrgReady,
    retry: shouldRetryDaemonError,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!query.error) return;
    captureError(query.error, { context: errorContext, bestEffort: true });
  }, [query.error, errorContext]);

  return {
    hasStoredCredential: query.data ?? false,
    isLoading: query.isLoading,
    queryKey,
  };
}
