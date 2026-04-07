import { parseInterfaceId } from "../channels/types.js";
import type { ConversationTransportMetadata } from "./message-types/conversations.js";

/**
 * Build enriched transport hints from conversation transport metadata.
 *
 * Interface ID first, then host environment (macOS only), then any
 * client-provided hints. Shared between the conversation creation path
 * (server.ts) and the queue drain path (conversation-process.ts).
 */
export function buildTransportHints(
  transport: ConversationTransportMetadata,
): string[] {
  const hints: string[] = [];

  const interfaceLabel = parseInterfaceId(transport.interfaceId) ?? "vellum";
  hints.push(`User is messaging from interface: ${interfaceLabel}`);

  if (transport.interfaceId === "macos") {
    if (transport.hostHomeDir) {
      hints.push(`Host home directory: ${transport.hostHomeDir}`);
    }
    if (transport.hostUsername) {
      hints.push(`Host username: ${transport.hostUsername}`);
    }
  }

  if (transport.hints) {
    hints.push(...transport.hints);
  }

  return hints;
}
