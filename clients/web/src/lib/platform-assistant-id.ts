import { remoteGatewayPublicBaseUrl } from "@/lib/auth/remote-gateway-session";
import { isRemoteGatewayMode } from "@/lib/local-mode";
import {
  fetchPlatformStatus,
  isUuid,
  resolveLocalAssistantPlatformIdentity,
} from "@/lib/local-platform-identity";
import { resolvePairedAssistantPlatformId } from "@/lib/paired-platform-identity";
import { getSelfHostedActorToken } from "@/lib/self-hosted/connection";

/**
 * Platform routes such as push-token upsert take a UUID. A self-hosted
 * phone may only know a lockfile slug, a paired id, or remote-gateway
 * `"self"`. Resolve those to the platform registration; a leftover
 * non-UUID would 404 on Django's `<uuid:assistant_id>` converter.
 */
export async function resolvePlatformAssistantId(
  assistantId: string,
): Promise<string | null> {
  if (isUuid(assistantId)) {
    return assistantId;
  }
  try {
    const resolved = await resolveLocalAssistantPlatformIdentity(assistantId, {
      allowGatewayRepair: false,
    });
    if (isUuid(resolved)) {
      return resolved;
    }
  } catch {
    // A missing lockfile entry or unsigned-in host is not fatal; try
    // the paired and remote-gateway lookups next.
  }
  const paired = await resolvePairedAssistantPlatformId(assistantId);
  if (paired && isUuid(paired)) {
    return paired;
  }
  if (isRemoteGatewayMode()) {
    try {
      const status = await fetchPlatformStatus(
        {
          gatewayUrl: remoteGatewayPublicBaseUrl(),
          actorToken: getSelfHostedActorToken(),
        },
        assistantId,
      );
      if (status?.assistantId && isUuid(status.assistantId)) {
        return status.assistantId;
      }
    } catch {
      // An unreachable gateway or missing window is not fatal.
    }
  }
  return null;
}
