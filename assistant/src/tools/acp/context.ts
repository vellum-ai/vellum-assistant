/**
 * Shared ToolContext accessors for the ACP tools.
 */

import type { AssistantEvent } from "../../daemon/message-protocol.js";
import type { ToolContext } from "../types.js";

/**
 * Narrows `ToolContext.sendToClient` to the `AssistantEvent` sender the ACP
 * session manager expects. ToolContext types the callback against an
 * index-signature message shape (`{ type: string; [key: string]: unknown }`)
 * that AssistantEvent's union members don't structurally satisfy, so the
 * cast lives here once instead of being duplicated at every ACP tool call
 * site.
 */
export function getSendToClient(
  context: ToolContext,
): ((msg: AssistantEvent) => void) | undefined {
  return context.sendToClient as ((msg: AssistantEvent) => void) | undefined;
}
