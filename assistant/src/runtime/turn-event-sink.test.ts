import { describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "../api/index.js";
import {
  createBatchedTurnEventSink,
  createTurnEventSink,
} from "./turn-event-sink.js";

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

describe("createBatchedTurnEventSink", () => {
  test("deduplicates shared publishers and targets open_url to one origin", () => {
    const publish = mock(() => {});
    const send = createBatchedTurnEventSink([
      { publish, originClientId: "client-1" },
      { publish, originClientId: "client-2" },
    ]);
    const textEvent: AssistantEvent = {
      type: "assistant_text_delta",
      text: "Hello",
      conversationId: "conv-1",
    };
    const openUrlEvent: AssistantEvent = {
      type: "open_url",
      url: "ms-settings:privacy-microphone",
      conversationId: "conv-1",
    };

    send(textEvent);
    send(openUrlEvent);

    expect(publish).toHaveBeenNthCalledWith(1, textEvent);
    expect(publish).toHaveBeenNthCalledWith(2, openUrlEvent, undefined, {
      targetClientId: "client-2",
    });
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
