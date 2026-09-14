import type { AssistantEvent } from "../api/index.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";

/**
 * Delivery sink for a top-level conversation: the assistant event hub,
 * scoped to that conversation.
 *
 * The hub attributes an event to a conversation from the id it is handed,
 * falling back to a `conversationId` on the payload, and that attribution
 * decides three things: which conversation-filtered subscribers receive the
 * event, whether it is seq-stamped, and whether it is replayed after a
 * reconnect. Binding the id here makes all three a property of the emitting
 * conversation rather than of each event's schema, so an event whose payload
 * names no conversation (`subagent_spawned`, `subagent_status_changed`) is
 * scoped exactly like one that does.
 *
 * Payload attribution stays the fallback for events published straight to the
 * hub, including `open_conversation`, whose id names the conversation to open
 * rather than the one it was emitted from.
 */
export function conversationEventSink(
  conversationId: string,
): (msg: AssistantEvent) => void {
  return (msg) => broadcastMessage(msg, conversationId);
}
