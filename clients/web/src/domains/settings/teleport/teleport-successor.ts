/**
 * Which platform assistant inherits the retiring source's managed OAuth
 * connections when the user confirms a teleport.
 *
 * A managed target is its own platform id. A local target only exists on the
 * platform once its identity bootstrap has registered it, so the id has to be
 * resolved (which performs that registration) before the source is retired:
 * retirement revokes the source's credentials, and the platform can only move
 * them to an assistant it already knows about.
 */

import {
  isUuid,
  resolveLocalAssistantPlatformIdentity,
} from "@/lib/local-platform-identity";
import { PlatformIdentityInjectionError } from "@/lib/platform-identity-errors";

export interface TeleportSuccessorTarget {
  id: string;
  kind: "managed" | "local";
}

/**
 * The successor's platform id, or null when a local target could not be
 * registered. Callers retire without a successor in that case; the
 * connections are lost with the source rather than the switch being blocked.
 *
 * A registration that exists but whose credential injection failed still
 * yields the id: the platform can move the connections to it, and the
 * retrying bootstrap completes the local side afterwards.
 */
export async function resolveTeleportSuccessorId(
  target: TeleportSuccessorTarget,
): Promise<string | null> {
  if (target.kind === "managed") {
    return target.id;
  }
  try {
    const resolved = await resolveLocalAssistantPlatformIdentity(target.id, {
      allowGatewayRepair: false,
    });
    return isUuid(resolved) ? resolved : null;
  } catch (error) {
    if (error instanceof PlatformIdentityInjectionError) {
      return error.platformAssistantId;
    }
    return null;
  }
}
