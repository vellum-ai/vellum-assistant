import type { ChannelId, InterfaceId } from "../channels/types.js";

/**
 * Desktop/browser/mobile local interfaces should share one default thread so
 * users can pick up the same conversation across devices without manually
 * passing a conversation key.
 */
const SHARED_LOCAL_HANDOFF_INTERFACES: ReadonlySet<InterfaceId> = new Set([
  "macos",
  "ios",
  "web",
  "chrome-extension",
  "tauri",
]);

const SHARED_LOCAL_HANDOFF_KEY = "default:vellum:handoff";

export function resolveDefaultConversationKey(
  sourceChannel: ChannelId,
  sourceInterface: InterfaceId,
): string {
  if (
    sourceChannel === "vellum" &&
    SHARED_LOCAL_HANDOFF_INTERFACES.has(sourceInterface)
  ) {
    return SHARED_LOCAL_HANDOFF_KEY;
  }
  return `default:${sourceChannel}:${sourceInterface}`;
}
