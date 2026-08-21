import type { AssistantEvent } from "../api/index.js";

type EventPublisher = (
  msg: AssistantEvent,
  conversationId?: string,
  options?: { targetClientId?: string },
) => void;

export function createTurnEventSink(
  publish: EventPublisher,
  originClientId?: string,
): (msg: AssistantEvent) => void {
  return (msg) => {
    const options =
      msg.type === "open_url" && originClientId
        ? { targetClientId: originClientId }
        : undefined;
    publish(msg, undefined, options);
  };
}
