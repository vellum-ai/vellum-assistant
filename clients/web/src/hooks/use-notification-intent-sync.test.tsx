/**
 * `useNotificationIntentSync` forwards `notification_intent` SSE events to
 * `postLocalNotification`, including remote-push acceptance metadata, and
 * skips the ones whose conversation is already in front of the user.
 *
 * The skip needs all three of: the store's active conversation, a route that
 * mounts the chat surface, and a window on screen. Route is driven by a real
 * `MemoryRouter` so the basename behaves as it does in remote-gateway mode;
 * window attention is a stubbed read.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import { __resetForTesting, publish } from "@/lib/event-bus";
import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";
import type { PostLocalNotificationArgs } from "@/runtime/notifications";

const CONVERSATION_ID = "conv-1";

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

let attended = true;
mock.module("@/runtime/event-sources/electron-window-attention", () => ({
  isWindowAttended: () => attended,
}));

const { useNotificationIntentSync } =
  await import("@/hooks/use-notification-intent-sync");

const originalHref = window.location.href;

/**
 * Mount the hook on `pathname`, optionally behind an ingress basename. The
 * browser URL is moved to the prefixed path too, the way remote-gateway mode
 * serves it, so the router path and `window.location.pathname` disagree
 * exactly as they do there.
 */
function mountAt(pathname: string, basename?: string): void {
  const entry = basename ? `${basename}${pathname}` : pathname;
  window.location.href = `http://localhost${entry}`;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter basename={basename} initialEntries={[entry]}>
      {children}
    </MemoryRouter>
  );
  renderHook(() => useNotificationIntentSync("assistant-1"), { wrapper });
}

function publishNotificationIntent(overrides: {
  remotePushDispatched?: boolean;
  remotePushPlatforms?: ("ios" | "android")[];
  deepLinkMetadata?: Record<string, unknown>;
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

/** An intent deep-linking to the conversation the store is sitting on. */
function publishForActiveConversation() {
  publishNotificationIntent({
    deepLinkMetadata: { conversationId: CONVERSATION_ID },
  });
}

function expectSuppressed() {
  expect(postedArgs).toHaveLength(0);
  expect(sendAckMock).toHaveBeenCalledTimes(1);
  expect(sendAckMock).toHaveBeenLastCalledWith(
    "assistant-1",
    "delivery-1",
    true,
  );
}

function expectNotified() {
  expect(postedArgs).toHaveLength(1);
  expect(sendAckMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  __resetForTesting();
  useConversationStore.getState().reset();
  attended = true;
  postedArgs.length = 0;
  postLocalNotificationMock.mockClear();
  sendAckMock.mockClear();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  window.location.href = originalHref;
});

describe("useNotificationIntentSync", () => {
  test("passes remote push acceptance through to postLocalNotification", () => {
    mountAt(routes.assistant);

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
    mountAt(routes.assistant);

    publishNotificationIntent({});

    expect(postedArgs).toHaveLength(1);
    expect(postedArgs[0]?.remotePushDispatched).toBeUndefined();
    expect(postedArgs[0]?.remotePushPlatforms).toBeUndefined();
  });
});

describe("useNotificationIntentSync already-watching skip", () => {
  beforeEach(() => {
    useConversationStore.getState().setActiveConversationId(CONVERSATION_ID);
  });

  test("skips and acks while the window is on screen and focused", () => {
    mountAt(routes.conversation(CONVERSATION_ID));

    publishForActiveConversation();

    expectSuppressed();
  });

  test("notifies when the window is off screen or unfocused", () => {
    attended = false;
    mountAt(routes.conversation(CONVERSATION_ID));

    publishForActiveConversation();

    expectNotified();
  });

  test("notifies for another conversation while attended", () => {
    mountAt(routes.conversation(CONVERSATION_ID));

    publishNotificationIntent({
      deepLinkMetadata: { conversationId: "conv-other" },
    });

    expectNotified();
  });

  test("notifies for another conversation while unattended", () => {
    attended = false;
    mountAt(routes.conversation(CONVERSATION_ID));

    publishNotificationIntent({
      deepLinkMetadata: { conversationId: "conv-other" },
    });

    expectNotified();
  });

  test("skips on the assistant index, which mounts the chat surface", () => {
    mountAt(routes.assistant);

    publishForActiveConversation();

    expectSuppressed();
  });

  test("notifies on the inspector, which replaces the transcript", () => {
    mountAt(routes.inspect(CONVERSATION_ID));

    publishForActiveConversation();

    expectNotified();
  });

  test("notifies on a route that mounts no chat surface", () => {
    mountAt(routes.settings.root);

    publishForActiveConversation();

    expectNotified();
  });

  test("skips behind a remote-gateway ingress basename", () => {
    mountAt(routes.conversation(CONVERSATION_ID), "/assistant-123");

    publishForActiveConversation();

    expectSuppressed();
  });
});
