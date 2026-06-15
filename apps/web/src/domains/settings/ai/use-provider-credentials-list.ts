import { useQuery } from "@tanstack/react-query";

import { secretsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { SecretsGetResponse } from "@/generated/daemon/types.gen";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseProviderCredentialsListOptions {
  assistantId: string;
  /** Extra guard — the query only fires when true. */
  enabled?: boolean;
}

/**
 * Fetches the list of stored credentials from the daemon and transforms them
 * into `CredentialEntry` pairs via `select`.
 *
 * Uses the generated `secretsGetOptions` factory for query key and fetch
 * logic. Errors propagate to the nearest error boundary via `throwOnError`.
 */
export function useProviderCredentialsList({
  assistantId,
  enabled = true,
}: UseProviderCredentialsListOptions) {
  const isOrgReady = useIsOrgReady();

  const query = useQuery({
    ...secretsGetOptions({ path: { assistant_id: assistantId } }),
    enabled: !!assistantId && enabled && isOrgReady,
    select: (data) => parseCredentialEntries(data.secrets),
    retry: shouldRetryDaemonError,
    staleTime: 30_000,
  });

  return {
    credentials: query.data ?? [],
    isLoading: query.isLoading,
  };
}
