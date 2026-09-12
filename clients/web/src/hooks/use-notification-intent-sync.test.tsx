/**
 * `useNotificationIntentSync` forwards `notification_intent` SSE events to
 * `postLocalNotification`, including remote-push acceptance metadata, and
 * skips the ones whose conversation is already in front of the user.
 *
 * The skip needs all three of: the store's active conversation, a route that
 * mounts the chat surface, and a client on screen. Route is driven by a real
 * `MemoryRouter` so the basename behaves as it does in remote-gateway mode.
 *
 * `isVisibleToUser` is deliberately NOT mocked. It branches on the host, and
 * one stub answers for both branches: every case here passes even while the
 * hook reads the desktop's always-true window-attention default and a hidden
 * tab swallows its own notification. The DOM is stubbed for the browser cases
 * and the preload bridge for the Electron ones instead.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { identityGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { resolveAssistantAvatarOwnerScopeId } from "@/hooks/use-assistant-avatar";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { useAuthStore } from "@/stores/auth-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useOrganizationStore } from "@/stores/organization-store";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
import type { PostLocalNotificationArgs } from "@/runtime/notifications";
import { isVisibleToUser } from "@/runtime/window-attention";
import { isConversationChatPath, routes } from "@/utils/routes";

const CONVERSATION_ID = "conv-1";
const PLATFORM_ASSISTANT_ID = "123e4567-e89b-12d3-a456-426614174000";
const PLATFORM_ASSISTANT: ResolvedAssistant = {
  id: "assistant-1",
  platformAssistantId: PLATFORM_ASSISTANT_ID,
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
};

const postedArgs: PostLocalNotificationArgs[] = [];
let soundDisposition: "web-sound" | "native-owned" = "web-sound";
const postLocalNotificationMock = mock(
  async (args: PostLocalNotificationArgs) => {
    postedArgs.push(args);
    return soundDisposition;
  },
);
const sendAckMock = mock(async () => {});
const focusedDeliveryKeys = new Set<string>();
const shouldSuppressFocusedNotificationDeliveryMock = mock(
  (
    correlationId: string | undefined,
    deliveryId: string | undefined,
    focused: boolean,
  ) => {
    const key = correlationId?.trim() || deliveryId?.trim();
    if (key && focusedDeliveryKeys.has(key)) {
      return true;
    }
    if (key && focused) {
      focusedDeliveryKeys.add(key);
    }
    return focused;
  },
);
mock.module("@/runtime/notifications", () => ({
  postLocalNotification: postLocalNotificationMock,
  sendNotificationIntentAck: sendAckMock,
  extractConversationId: (metadata?: Record<string, unknown>) =>
    typeof metadata?.conversationId === "string"
      ? metadata.conversationId
      : undefined,
  isFocusedNotificationConversation: (
    conversationId: string,
    pathname: string,
  ) =>
    conversationId === useConversationStore.getState().activeConversationId &&
    isConversationChatPath(pathname) &&
    isVisibleToUser(),
  shouldSuppressFocusedNotificationDelivery:
    shouldSuppressFocusedNotificationDeliveryMock,
}));

const playSoundMock = mock(async () => {});
mock.module("@/lib/sounds/sound-manager", () => ({
  getSoundManager: () => ({ play: playSoundMock }),
}));

const { useNotificationIntentSync } =
  await import("@/hooks/use-notification-intent-sync");
const { subscribeToWindowAttention } =
  await import("@/runtime/window-attention");

const realVisibilityState = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

/** Drive the browser's own answer to "is this client on screen". */
function setVisibilityState(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

let attentionListener: ((payload: unknown) => void) | null = null;
let stopAttention: (() => void) | null = null;

/**
 * Run as the Electron renderer does, with main pushing this window's state.
 * The DOM stays `"visible"` throughout, the way a Vellum window with
 * background throttling disabled reports it whatever the window is doing.
 */
function runInElectron(attended: boolean): void {
  window.vellum = {
    platform: "electron",
    notifications: {
      onWindowAttention: (callback: (payload: unknown) => void) => {
        attentionListener = callback;
        return () => {
          attentionListener = null;
        };
      },
    },
  } as unknown as Window["vellum"];
  stopAttention = subscribeToWindowAttention(() => undefined);
  attentionListener?.({
    visible: attended,
    focused: attended,
    minimized: !attended,
  });
}

const originalHref = window.location.href;
let queryClient: QueryClient;

/**
 * Mount the hook on `pathname`, optionally behind an ingress basename. The
 * browser URL is moved to the prefixed path too, the way remote-gateway mode
 * serves it, so the router path and `window.location.pathname` disagree
 * exactly as they do there.
 */
function mountAt(
  pathname: string,
  basename?: string,
  initialAssistantId = "assistant-1",
) {
  const entry = basename ? `${basename}${pathname}` : pathname;
  window.location.href = `http://localhost${entry}`;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter basename={basename} initialEntries={[entry]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  return renderHook(
    ({ assistantId }) => useNotificationIntentSync(assistantId),
    { wrapper, initialProps: { assistantId: initialAssistantId } },
  );
}

function publishNotificationIntent(overrides: {
  assistantName?: string;
  sourceEventName?: string;
  title?: string;
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
  expect(playSoundMock).not.toHaveBeenCalled();
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

function platformScopeId(): string {
  const scopeId = resolveAssistantAvatarOwnerScopeId(
    PLATFORM_ASSISTANT,
    "account-1",
    "org-1",
    window.location.href,
  );
  if (!scopeId) {
    throw new Error("Expected a platform notification scope");
  }
  return scopeId;
}

function identityQueryKey(assistantId: string, scopeId: string) {
  return [
    ...identityGetQueryKey({ path: { assistant_id: assistantId } }),
    { notificationOwnerScopeId: scopeId },
  ];
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  __resetForTesting();
  useAuthStore.setState({
    sessionStatus: "authenticated",
    user: {
      kind: "platform",
      id: "account-1",
      username: "user1",
      email: "user@example.com",
      isStaff: false,
      firstName: "Example",
      lastName: "User",
    },
  });
  useOrganizationStore.setState({
    currentOrganizationId: "org-1",
    persistedOrganizationId: "org-1",
  });
  useResolvedAssistantsStore.setState({
    assistants: [PLATFORM_ASSISTANT],
    activeAssistantId: "assistant-1",
  });
  useConversationStore.getState().reset();
  setVisibilityState("visible");
  postedArgs.length = 0;
  soundDisposition = "web-sound";
  postLocalNotificationMock.mockClear();
  playSoundMock.mockClear();
  sendAckMock.mockClear();
  focusedDeliveryKeys.clear();
  shouldSuppressFocusedNotificationDeliveryMock.mockClear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  __resetForTesting();
  stopAttention?.();
  stopAttention = null;
  attentionListener = null;
  delete window.vellum;
  if (realVisibilityState) {
    Object.defineProperty(document, "visibilityState", realVisibilityState);
  }
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
      expect.objectContaining({
        title: "Reminder",
        body: "Stand up",
        sourceEventName: "reminder.fired",
        deliveryId: "delivery-1",
        correlationId: "signal-1",
        deepLinkMetadata: undefined,
        assistantId: "assistant-1",
        remotePushDispatched: true,
        remotePushPlatforms: ["android"],
      }),
    ]);
    expect(postedArgs[0]?.identity).toEqual({
      scopeId: platformScopeId(),
      assistantId: "assistant-1",
      nativeSenderId: PLATFORM_ASSISTANT_ID,
    });
    expect(postedArgs[0]?.identity?.scopeId).not.toContain("account-1");
    expect(postedArgs[0]?.identity?.scopeId).not.toContain("org-1");
  });

  test("plays web sound only when the display route leaves sound to web", async () => {
    mountAt(routes.assistant);

    publishNotificationIntent({});
    await act(async () => {
      await Promise.resolve();
    });

    expect(playSoundMock).toHaveBeenCalledTimes(1);
  });

  test("does not add sound after the Android coordinator owns delivery", async () => {
    soundDisposition = "native-owned";
    mountAt(routes.assistant);

    publishNotificationIntent({});
    await act(async () => {
      await Promise.resolve();
    });

    expect(playSoundMock).not.toHaveBeenCalled();
  });

  test("a slow native-owned result never triggers an early web sound", async () => {
    let finishPost!: (value: "native-owned") => void;
    postLocalNotificationMock.mockImplementationOnce(
      async (args: PostLocalNotificationArgs) => {
        postedArgs.push(args);
        return new Promise<"native-owned">((resolve) => {
          finishPost = resolve;
        });
      },
    );
    mountAt(routes.assistant);

    publishNotificationIntent({});
    await act(async () => {
      await Promise.resolve();
    });
    expect(playSoundMock).not.toHaveBeenCalled();

    await act(async () => {
      finishPost("native-owned");
      await Promise.resolve();
    });
    expect(playSoundMock).not.toHaveBeenCalled();
  });

  test("leaves remotePushDispatched undefined when the daemon omits it", () => {
    mountAt(routes.assistant);

    publishNotificationIntent({});

    expect(postedArgs).toHaveLength(1);
    expect(postedArgs[0]?.remotePushDispatched).toBeUndefined();
    expect(postedArgs[0]?.remotePushPlatforms).toBeUndefined();
    expect(postedArgs[0]?.assistantName).toBeUndefined();
  });

  test("threads the optional event name and exact scoped identity query name", () => {
    const scopeId = platformScopeId();
    queryClient.setQueryData(identityQueryKey("assistant-1", scopeId), {
      name: "Scoped Name",
      version: "1.0.0",
    });
    mountAt(routes.assistant);

    publishNotificationIntent({ assistantName: "Event Name" });

    expect(postedArgs[0]?.assistantName).toBe("Event Name");
    const identity = postedArgs[0]?.identity;
    if (!identity) {
      throw new Error("expected originating notification identity");
    }
    expect(postedArgs[0]?.identityStoreName).toEqual({
      identity,
      name: "Scoped Name",
    });
  });

  test("does not relabel a name cached for the same assistant in another scope", () => {
    const currentScopeId = platformScopeId();
    queryClient.setQueryData(
      identityQueryKey("assistant-1", "notification:scope:old"),
      { name: "Old Scope Name", version: "1.0.0" },
    );
    mountAt(routes.assistant);

    publishNotificationIntent({});

    expect(postedArgs[0]?.identity?.scopeId).toBe(currentScopeId);
    expect(postedArgs[0]?.identityStoreName).toBeNull();
  });

  test("keeps delayed work bound to self-hosted origin A after selecting B", () => {
    const assistantA: ResolvedAssistant = {
      id: "local-a",
      isLocal: true,
      isPlatformHosted: false,
      isPaired: true,
      runtimeUrl: "https://a.example.com/assistant",
    };
    const assistantB: ResolvedAssistant = {
      id: "local-b",
      isLocal: true,
      isPlatformHosted: false,
      isPaired: true,
      runtimeUrl: "https://b.example.com/assistant",
    };
    useAuthStore.setState({
      user: {
        kind: "local",
        id: "gateway-local",
        username: null,
        email: null,
        isStaff: false,
        firstName: "",
        lastName: "",
      },
    });
    useOrganizationStore.setState({
      currentOrganizationId: null,
      persistedOrganizationId: null,
    });
    useResolvedAssistantsStore.setState({
      assistants: [assistantA, assistantB],
      activeAssistantId: assistantA.id,
    });
    const mounted = mountAt(routes.assistant, undefined, assistantA.id);

    publishNotificationIntent({ assistantName: "Origin A" });
    const originA = postedArgs[0]?.identity;

    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: assistantB.id });
      mounted.rerender({ assistantId: assistantB.id });
    });

    expect(originA).toMatchObject({
      scopeId: resolveAssistantAvatarOwnerScopeId(
        assistantA,
        null,
        null,
        window.location.href,
      ),
      assistantId: assistantA.id,
    });
    expect(originA?.nativeSenderId.startsWith("local:")).toBe(true);
    expect(originA?.scopeId).not.toContain("a.example.com");
    expect(postedArgs[0]?.assistantId).toBe(assistantA.id);
    expect(postedArgs[0]?.assistantName).toBe("Origin A");
  });
});

describe("useNotificationIntentSync already-watching skip", () => {
  beforeEach(() => {
    useConversationStore.getState().setActiveConversationId(CONVERSATION_ID);
  });

  test("skips and acks while the tab is on screen", () => {
    mountAt(routes.conversation(CONVERSATION_ID));

    publishForActiveConversation();

    expectSuppressed();
  });

  test("retained FCM focus suppression keeps the original SSE ack id", () => {
    focusedDeliveryKeys.add("signal-1");
    mountAt(routes.settings.root);

    publishNotificationIntent({});

    expectSuppressed();
    expect(sendAckMock).toHaveBeenLastCalledWith(
      "assistant-1",
      "delivery-1",
      true,
    );
  });

  // A hidden tab shows nothing, and the web has no push fallback to deliver
  // the notification again, so a skip here acks a delivery nobody ever saw.
  test("notifies a hidden browser tab sitting on the conversation", () => {
    setVisibilityState("hidden");
    mountAt(routes.conversation(CONVERSATION_ID));

    publishForActiveConversation();

    expectNotified();
  });

  test("skips while the desktop window is on screen and focused", () => {
    runInElectron(true);
    mountAt(routes.conversation(CONVERSATION_ID));

    publishForActiveConversation();

    expectSuppressed();
  });

  test("notifies when the desktop window is off screen or unfocused", () => {
    runInElectron(false);
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
    setVisibilityState("hidden");
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
