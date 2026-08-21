import { describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "../api/index.js";
import { createTurnEventSink } from "./turn-event-sink.js";

describe("createTurnEventSink", () => {
  test("targets open_url events to the originating client", () => {
    const publish = mock(() => {});
    const send = createTurnEventSink(publish, "client-1");
    const event: AssistantEvent = {
      type: "open_url",
      url: "ms-settings:privacy-microphone",
      conversationId: "conv-1",
    };

    send(event);

    expect(publish).toHaveBeenCalledWith(event, undefined, {
      targetClientId: "client-1",
    });
  });

  test("leaves other turn events and clientless open_url events untargeted", () => {
    const publish = mock(() => {});
    const targetedSend = createTurnEventSink(publish, "client-1");
    const untargetedSend = createTurnEventSink(publish);
    const textEvent: AssistantEvent = {
      type: "assistant_text_delta",
      text: "Hello",
      conversationId: "conv-1",
    };
    const openUrlEvent: AssistantEvent = {
      type: "open_url",
      url: "https://example.com",
      conversationId: "conv-1",
    };

    targetedSend(textEvent);
    untargetedSend(openUrlEvent);

    expect(publish).toHaveBeenNthCalledWith(1, textEvent, undefined, undefined);
    expect(publish).toHaveBeenNthCalledWith(
      2,
      openUrlEvent,
      undefined,
      undefined,
    );
  });
});
