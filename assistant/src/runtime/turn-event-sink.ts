import type { AssistantEvent } from "../api/index.js";

export type TurnEventPublisher = (
  msg: AssistantEvent,
  conversationId?: string,
  options?: { targetClientId?: string },
) => void;

export function createTurnEventSink(
  publish: TurnEventPublisher,
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

export function createBatchedTurnEventSink(
  members: ReadonlyArray<{
    publish: TurnEventPublisher;
    originClientId?: string;
  }>,
): (msg: AssistantEvent) => void {
  const publishers = Array.from(
    new Set(members.map((member) => member.publish)),
  );
  let origin: (typeof members)[number] | undefined;
  for (let index = members.length - 1; index >= 0; index -= 1) {
    if (members[index].originClientId) {
      origin = members[index];
      break;
    }
  }
  const targetedSink = origin
    ? createTurnEventSink(origin.publish, origin.originClientId)
    : undefined;

  return (msg) => {
    if (msg.type === "open_url" && targetedSink) {
      targetedSink(msg);
      return;
    }
    for (const publish of publishers) {
      publish(msg);
    }
  };
}
