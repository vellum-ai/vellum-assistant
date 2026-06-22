import { useQuery } from "@tanstack/react-query";

import { secretsReadPost } from "@/generated/daemon/sdk.gen";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

/**
 * Stable query key for credential-presence checks.
 *
 * `secretsReadPost` is a POST endpoint, so HeyAPI generates a mutation
 * factory (no query key). This hook uses `useQuery` because the operation
 * is semantically a read ("does this credential exist?"). The key factory
 * is exported so consumers can invalidate or optimistically update the
 * cache after saving a credential.
 */
export function credentialPresenceQueryKey(
  assistantId: string,
  credentialKind: string,
  credentialName: string,
) {
  return ["credentialPresence", assistantId, credentialKind, credentialName] as const;
}

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
}

/**
 * Checks whether a stored credential exists on the daemon.
 *
 * Uses `secretsReadPost` (a POST-as-read endpoint) wrapped in `useQuery`.
 * Errors propagate to the nearest error boundary via `throwOnError`.
 */
export function useStoredCredentialPresence({
  assistantId,
  credentialKind,
  credentialName,
  enabled = true,
}: UseStoredCredentialPresenceOptions) {
  const isOrgReady = useIsOrgReady();

  const query = useQuery({
    queryKey: credentialPresenceQueryKey(assistantId ?? "", credentialKind, credentialName),
    queryFn: async () => {
      const { data } = await secretsReadPost({
        path: { assistant_id: assistantId! },
        body: { type: credentialKind, name: credentialName },
        throwOnError: true,
      });
      return data.found;
    },
    enabled: !!assistantId && enabled && isOrgReady,
    retry: shouldRetryDaemonError,
    staleTime: 30_000,
  });

  return {
    hasStoredCredential: query.data ?? false,
    isLoading: query.isLoading,
  };
}
