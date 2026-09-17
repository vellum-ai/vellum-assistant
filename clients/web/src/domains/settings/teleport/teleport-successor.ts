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

import { resolvePlatformAssistantId } from "@/lib/platform-assistant-id";

export interface TeleportSuccessorTarget {
  id: string;
  kind: "managed" | "local";
}

/**
 * The successor's platform id, or null when a local target could not be
 * registered in time. Callers retire without a successor in that case; the
 * connections are lost with the source rather than the switch being blocked.
 */
export async function resolveTeleportSuccessorId(
  target: TeleportSuccessorTarget,
): Promise<string | null> {
  if (target.kind === "managed") {
    return target.id;
  }
  return resolvePlatformAssistantId(target.id);
}
