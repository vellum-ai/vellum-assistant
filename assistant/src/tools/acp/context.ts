/**
 * Shared CoreToolContext accessors for the ACP tools.
 */

import type { ServerMessage } from "../../daemon/message-protocol.js";
import type { CoreToolContext } from "../types.js";

/**
 * Narrows `CoreToolContext.sendToClient` to the `ServerMessage` sender the ACP
 * session manager expects. CoreToolContext types the callback against an
 * index-signature message shape (`{ type: string; [key: string]: unknown }`)
 * that ServerMessage's union members don't structurally satisfy, so the
 * cast lives here once instead of being duplicated at every ACP tool call
 * site.
 */
export function getSendToClient(
  context: CoreToolContext,
): ((msg: ServerMessage) => void) | undefined {
  return context.sendToClient as ((msg: ServerMessage) => void) | undefined;
}
