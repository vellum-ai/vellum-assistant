/**
 * `useNotificationIntentSync` forwards `notification_intent` SSE events to
 * `postLocalNotification`, including remote-push acceptance metadata.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { __resetForTesting, publish } from "@/lib/event-bus";
import { useConversationStore } from "@/stores/conversation-store";
import type { PostLocalNotificationArgs } from "@/runtime/notifications";

const postedArgs: PostLocalNotificationArgs[] = [];
const postLocalNotificationMock = mock(
  async (args: PostLocalNotificationArgs) => {
    postedArgs.push(args);
  },
);
const sendAckMock = mock(async () => {});
mock.module("@/runtime/notifications", () => ({
  postLocalNotification: postLocalNotificationMock,
  sendNotificationIntentAck: sendAckMock,
  extractConversationId: (metadata?: Record<string, unknown>) =>
    typeof metadata?.conversationId === "string"
      ? metadata.conversationId
      : undefined,
}));

mock.module("@/lib/sounds/sound-manager", () => ({
  getSoundManager: () => ({ play: async () => {} }),
}));

const { useNotificationIntentSync } = await import(
  "@/hooks/use-notification-intent-sync"
);

function publishNotificationIntent(overrides: {
  remotePushDispatched?: boolean;
  remotePushPlatforms?: ("ios" | "android")[];
}) {
  act(() => {
    publish("sse.event", {
      id: "evt-1",
      emittedAt: new Date().toISOString(),
      message: {
        type: "notification_intent",
        sourceEventName: "reminder.fired",
        title: "Reminder",
        body: "Stand up",
        deliveryId: "delivery-1",
        correlationId: "signal-1",
        ...overrides,
      },
    });
  });
}

beforeEach(() => {
  __resetForTesting();
  useConversationStore.getState().reset();
  postedArgs.length = 0;
  postLocalNotificationMock.mockClear();
  sendAckMock.mockClear();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useNotificationIntentSync", () => {
  test("passes remote push acceptance through to postLocalNotification", () => {
    renderHook(() => useNotificationIntentSync("assistant-1"));

    publishNotificationIntent({
      remotePushDispatched: true,
      remotePushPlatforms: ["android"],
    });

    expect(postedArgs).toEqual([
      {
        title: "Reminder",
        body: "Stand up",
        sourceEventName: "reminder.fired",
        deliveryId: "delivery-1",
        correlationId: "signal-1",
        deepLinkMetadata: undefined,
        assistantId: "assistant-1",
        remotePushDispatched: true,
        remotePushPlatforms: ["android"],
      },
    ]);
  });

  test("leaves remotePushDispatched undefined when the daemon omits it", () => {
    renderHook(() => useNotificationIntentSync("assistant-1"));

    publishNotificationIntent({});

    expect(postedArgs).toHaveLength(1);
    expect(postedArgs[0]?.remotePushDispatched).toBeUndefined();
    expect(postedArgs[0]?.remotePushPlatforms).toBeUndefined();
  });
});
