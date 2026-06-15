import { useEffect, useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { secretsGet } from "@/generated/daemon/sdk.gen";
import type { SecretsGetResponse } from "@/generated/daemon/types.gen";
import { ApiError, assertHasResponse, extractErrorMessage } from "@/utils/api-errors";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import { captureError } from "@/lib/sentry/capture-error";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";

// ---------------------------------------------------------------------------
// Credential-entry parser (transforms secrets list into service/field pairs)
// ---------------------------------------------------------------------------

export interface CredentialEntry {
  service: string;
  field: string;
}

type SecretEntry = SecretsGetResponse["secrets"][number];

/**
 * Parse a typed secrets-list response into credential entries suitable for
 * the provider-editor's Advanced dropdown.
 */
export function parseCredentialEntries(
  entries: readonly SecretEntry[],
): CredentialEntry[] {
  const results: CredentialEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "api_key") {
      results.push({ service: entry.name, field: "api_key" });
    } else if (entry.type === "credential") {
      const colonIdx = entry.name.lastIndexOf(":");
      if (colonIdx >= 0) {
        const service = entry.name.slice(0, colonIdx);
        const field = entry.name.slice(colonIdx + 1);
        if (service && field) results.push({ service, field });
      }
    }
  }
  return results;
}

const PROVIDER_CREDENTIALS_LIST_QK = "provider-credentials-list" as const;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseProviderCredentialsListOptions {
  assistantId: string;
  /** Extra guard — the query only fires when true. */
  enabled?: boolean;
}

/**
 * Fetches the list of stored credentials from the daemon.
 *
 * Wraps `secretsGet` in a TanStack Query hook with org-readiness gating,
 * retry logic for transient daemon errors, and Sentry reporting for
 * persistent failures.
 */
export function useProviderCredentialsList({
  assistantId,
  enabled = true,
}: UseProviderCredentialsListOptions) {
  const isOrgReady = useIsOrgReady();

  const queryKey = useMemo(
    () => [PROVIDER_CREDENTIALS_LIST_QK, assistantId] as const,
    [assistantId],
  );

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error, response } = await secretsGet({
        path: { assistant_id: assistantId },
        throwOnError: false,
      });
      assertHasResponse(response, error, "Failed to load credentials");
      if (!response.ok) {
        throw new ApiError(
          response.status,
          extractErrorMessage(error, response, `Failed to load credentials (HTTP ${response.status})`),
        );
      }
      return parseCredentialEntries(data!.secrets ?? data!.accounts ?? []);
    },
    enabled: !!assistantId && enabled && isOrgReady,
    retry: shouldRetryDaemonError,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!query.error) return;
    captureError(query.error, {
      context: "settings-provider-editor-credentials-list",
      bestEffort: true,
    });
  }, [query.error]);

  return {
    credentials: query.data ?? [],
    isLoading: query.isLoading,
    queryKey,
  };
}
