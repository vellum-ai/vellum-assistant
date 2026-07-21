/**
 * Thin API layer for minting one-time credential-request links.
 *
 * The daemon's credential-requests route is not yet in the generated SDK,
 * so this module calls it directly via the daemon client (same escape-hatch
 * pattern as `domains/settings/mcp/mcp-api.ts`). The gateway proxies it
 * transparently via `/v1/assistants/{id}/credential-requests`.
 */

import { client } from "@/generated/daemon/client.gen";

/**
 * Response of `POST /v1/assistants/{assistant_id}/credential-requests`.
 * `error` is set when `ok` is false (e.g. the feature flag is disabled or
 * no public ingress URL is configured for the assistant).
 */
export interface CreateCredentialRequestResult {
  ok: boolean;
  url?: string;
  token?: string;
  expiresAt?: number;
  error?: string;
}

/** Normalize an epoch that may be seconds or milliseconds to milliseconds. */
export function credentialRequestExpiryToEpochMs(value: number): number {
  return value > 1_000_000_000_000 ? value : value * 1000;
}

export async function createCredentialRequest(
  assistantId: string,
  body: { service: string; field: string; label?: string },
): Promise<CreateCredentialRequestResult> {
  const { data, response } = await client.post({
    url: "/v1/assistants/{assistant_id}/credential-requests" as "/v1/assistants/{assistant_id}/config",
    path: { assistant_id: assistantId },
    body: body as Record<string, unknown>,
  });
  if (!response?.ok) {
    throw new Error(`Failed to create credential request: ${response?.status}`);
  }
  return data as unknown as CreateCredentialRequestResult;
}
