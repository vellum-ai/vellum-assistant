import type { AssistantEvent } from "../api/index.js";
import type { AssistantEventHub } from "./assistant-event-hub.js";
import { enforceSameActorOrThrow } from "./auth/same-actor.js";

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

export function createAuthenticatedTurnEventSink(args: {
  publish: TurnEventPublisher;
  originClientId?: string;
  sourceActorPrincipalId?: string;
  hub: Pick<AssistantEventHub, "getActorPrincipalIdForClient">;
}): (msg: AssistantEvent) => void {
  const { publish, originClientId, sourceActorPrincipalId, hub } = args;
  if (originClientId) {
    enforceSameActorOrThrow({
      hub,
      sourceActorPrincipalId,
      targetClientId: originClientId,
      op: "conversation_open_url",
    });
  }
  return createTurnEventSink(publish, originClientId);
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
  const responseOwner = members.at(-1);
  const targetedSink = responseOwner?.originClientId
    ? createTurnEventSink(responseOwner.publish, responseOwner.originClientId)
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
