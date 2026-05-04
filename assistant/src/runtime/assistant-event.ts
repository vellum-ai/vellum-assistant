/**
 * Assistant Events -- thin re-export layer.
 *
 * The shared types and SSE framing helpers live in the neutral
 * `@vellumai/skill-host-contracts` package so isolated skill processes
 * can consume them without pulling in the daemon. This file pins the
 * generic payload to the daemon-side `ServerMessage` union so existing
 * callers continue to get full discriminated-union narrowing.
 */

import type { AssistantEvent as BaseAssistantEvent } from "@vellumai/skill-host-contracts";
import { buildAssistantEvent as baseBuildAssistantEvent } from "@vellumai/skill-host-contracts";

import type { ServerMessage } from "../daemon/message-protocol.js";

export {
  formatSseFrame,
  formatSseHeartbeat,
  formatSseHeartbeatWithData,
} from "@vellumai/skill-host-contracts";

/** Daemon-side specialization of the generic event envelope. */
export type AssistantEvent = BaseAssistantEvent<ServerMessage>;

/** Daemon-side wrapper preserving the original `ServerMessage`-typed signature. */
export function buildAssistantEvent(
  message: ServerMessage,
  conversationId?: string,
): AssistantEvent {
  return baseBuildAssistantEvent<ServerMessage>(message, conversationId);
}
