import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import type { NotificationIdentity } from "@vellumai/ipc-contract";

import * as switchServiceRuntime from "@/assistant/switch-service";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import {
  resolveAssistantAvatarOwnerScopeId,
  resolveAssistantNotificationPlatformId,
} from "@/hooks/use-assistant-avatar";
import { __resetForTesting, subscribe } from "@/lib/event-bus";
import { createNotificationIdentity } from "@/runtime/notification-avatar";
import {
  __resetNotificationTapsForTests,
  dispatchNotificationTap,
  registerNotificationTapHandler,
  type NotificationTapHandler,
  type NotificationTapPayload,
} from "@/runtime/notification-taps";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";

const ASSISTANT_A: ResolvedAssistant = {
  id: "assistant-a",
  platformAssistantId: "123e4567-e89b-12d3-a456-426614174000",
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
};
const ASSISTANT_B: ResolvedAssistant = {
  id: "assistant-b",
  platformAssistantId: "123e4567-e89b-12d3-a456-426614174001",
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
};

let capturedHandler: NotificationTapHandler | null = null;
const setNotificationTapHandlerMock = mock((handler: NotificationTapHandler) => {
  capturedHandler = handler;
});
const postLocalNotificationMock = mock(async () => {});
mock.module("@/runtime/notifications", () => ({
  setNotificationTapHandler: setNotificationTapHandlerMock,
  postLocalNotification: postLocalNotificationMock,
}));

const switchToResolvedAssistantMock = mock(
  async (assistant: ResolvedAssistant) => {
    useResolvedAssistantsStore.setState({
      selectedAssistantId: assistant.id,
      activeAssistantId: assistant.id,
    });
  },
);
mock.module("@/assistant/switch-service", () => ({
  ...switchServiceRuntime,
  switchToResolvedAssistant: switchToResolvedAssistantMock,
}));

const sentryBreadcrumbMock = mock((_args: unknown) => undefined);
mock.module("@sentry/react", () => ({
  addBreadcrumb: sentryBreadcrumbMock,
  captureException: () => {},
}));

const { useNotificationTapNavigation } =
  await import("./use-notification-tap-navigation");

function platformIdentity(
  assistant: ResolvedAssistant = ASSISTANT_A,
  accountId = "account-1",
  organizationId = "org-1",
): NotificationIdentity {
  const scopeId = resolveAssistantAvatarOwnerScopeId(
    assistant,
    accountId,
    organizationId,
    window.location.href,
  );
  const identity = scopeId
    ? createNotificationIdentity(
        scopeId,
        assistant.id,
        resolveAssistantNotificationPlatformId(assistant),
      )
    : null;
  if (!identity) {
    throw new Error("expected notification identity");
  }
  return identity;
}

async function sendTap(payload: NotificationTapPayload): Promise<void> {
  const handler = capturedHandler;
  if (!handler) {
    throw new Error("expected notification tap handler");
  }
  await act(async () => {
    await handler(payload);
  });
}

function collectThreadOpens(): Array<{ threadId: string }> {
  const received: Array<{ threadId: string }> = [];
  subscribe("deeplink.openThread", (payload) => {
    received.push(payload);
  });
  return received;
}

beforeEach(() => {
  __resetForTesting();
  __resetNotificationTapsForTests();
  capturedHandler = null;
  setNotificationTapHandlerMock.mockClear();
  postLocalNotificationMock.mockClear();
  switchToResolvedAssistantMock.mockReset();
  sentryBreadcrumbMock.mockClear();
  window.history.pushState(null, "", "/");
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
    status: "ready",
  });
  useResolvedAssistantsStore.setState({
    assistants: [ASSISTANT_A, ASSISTANT_B],
    assistantsHydrated: true,
    selectedAssistantId: ASSISTANT_B.id,
    activeAssistantId: ASSISTANT_B.id,
  });
  useAssistantLifecycleStore.setState({
    assistantState: { kind: "active", isLocal: false },
  });
  switchToResolvedAssistantMock.mockImplementation(
    async (assistant: ResolvedAssistant) => {
      useResolvedAssistantsStore.setState({
        selectedAssistantId: assistant.id,
        activeAssistantId: assistant.id,
      });
    },
  );
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  __resetNotificationTapsForTests();
  window.history.pushState(null, "", "/");
});

describe("useNotificationTapNavigation", () => {
  test("mounting registers a tap handler", () => {
    renderHook(() => useNotificationTapNavigation());

    expect(setNotificationTapHandlerMock).toHaveBeenCalledTimes(1);
    expect(capturedHandler).not.toBeNull();
  });

  test("a popout registers no handler or navigation", () => {
    window.history.pushState(null, "", "/?popout=1");
    const received = collectThreadOpens();

    renderHook(() => useNotificationTapNavigation());

    expect(setNotificationTapHandlerMock).not.toHaveBeenCalled();
    expect(capturedHandler).toBeNull();
    expect(received).toEqual([]);
  });

  test("a legacy conversation-only tap remains compatible", async () => {
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({ conversationId: "conv-legacy", sourceEventName: "x" });

    expect(received).toEqual([{ threadId: "conv-legacy" }]);
    expect(switchToResolvedAssistantMock).not.toHaveBeenCalled();
    expect(postLocalNotificationMock).not.toHaveBeenCalled();
  });

  test("a tap without a conversation publishes nothing", async () => {
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({ sourceEventName: "x" });

    expect(received).toEqual([]);
    expect(sentryBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "tap_without_conversation" }),
    );
  });

  test("switches back to the scoped origin before opening its conversation", async () => {
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-a",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });

    expect(switchToResolvedAssistantMock).toHaveBeenCalledWith(ASSISTANT_A);
    expect(received).toEqual([{ threadId: "conv-a" }]);
    expect(postLocalNotificationMock).not.toHaveBeenCalled();
  });

  test("opens an already active scoped target without reconnecting", async () => {
    useResolvedAssistantsStore.setState({
      selectedAssistantId: ASSISTANT_A.id,
      activeAssistantId: ASSISTANT_A.id,
    });
    switchToResolvedAssistantMock.mockRejectedValueOnce(
      new Error("offline reconnect should not run"),
    );
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-active",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });

    expect(switchToResolvedAssistantMock).not.toHaveBeenCalled();
    expect(received).toEqual([{ threadId: "conv-active" }]);
  });

  test("restores selection when the target is active but another is pending", async () => {
    useResolvedAssistantsStore.setState({
      selectedAssistantId: ASSISTANT_B.id,
      activeAssistantId: ASSISTANT_A.id,
    });
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-restore",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });

    expect(switchToResolvedAssistantMock).toHaveBeenCalledWith(ASSISTANT_A);
    expect(received).toEqual([{ threadId: "conv-restore" }]);
  });

  test("waits for lifecycle activation after the selection write", async () => {
    switchToResolvedAssistantMock.mockImplementationOnce(async (assistant) => {
      useResolvedAssistantsStore.setState({
        selectedAssistantId: assistant.id,
      });
    });
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();
    const handler = capturedHandler;
    if (!handler) {
      throw new Error("expected notification tap handler");
    }

    const pendingTap = Promise.resolve(
      handler({
        conversationId: "conv-wait",
        sourceEventName: "reminder.fired",
        identity: platformIdentity(ASSISTANT_A),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(switchToResolvedAssistantMock).toHaveBeenCalledWith(ASSISTANT_A);
    expect(received).toEqual([]);

    act(() => {
      useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_A.id });
    });
    await pendingTap;

    expect(received).toEqual([{ threadId: "conv-wait" }]);
  });

  test("a terminal lifecycle failure releases the next queued tap", async () => {
    switchToResolvedAssistantMock.mockImplementationOnce(async (assistant) => {
      useResolvedAssistantsStore.setState({
        selectedAssistantId: assistant.id,
      });
    });
    renderHook(() => useNotificationTapNavigation());
    const handler = capturedHandler;
    if (!handler) {
      throw new Error("expected notification tap handler");
    }
    registerNotificationTapHandler(handler);
    const received = collectThreadOpens();

    dispatchNotificationTap({
      conversationId: "conv-failed-activation",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });
    dispatchNotificationTap({
      conversationId: "conv-after-failure",
      sourceEventName: "legacy",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([]);

    act(() => {
      useAssistantLifecycleStore.setState({
        assistantState: { kind: "error", message: "activation failed" },
      });
    });

    await waitFor(() => {
      expect(received).toEqual([{ threadId: "conv-after-failure" }]);
    });
    expect(received).not.toContainEqual({
      threadId: "conv-failed-activation",
    });
  });

  test("does not open a removed assistant target", async () => {
    const identity = platformIdentity(ASSISTANT_A);
    useResolvedAssistantsStore.setState({ assistants: [ASSISTANT_B] });
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-removed",
      sourceEventName: "reminder.fired",
      identity,
    });

    expect(switchToResolvedAssistantMock).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  test("does not open an identity from a stale account or organization scope", async () => {
    const staleIdentity = platformIdentity(ASSISTANT_A, "account-old", "org-old");
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-stale",
      sourceEventName: "reminder.fired",
      identity: staleIdentity,
    });

    expect(switchToResolvedAssistantMock).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  test("waits for cold-start assistant hydration before validating", async () => {
    const identity = platformIdentity(ASSISTANT_A);
    useResolvedAssistantsStore.setState({
      assistants: [],
      assistantsHydrated: false,
    });
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    const pendingTap = sendTap({
      conversationId: "conv-cold",
      sourceEventName: "reminder.fired",
      identity,
    });
    await Promise.resolve();
    expect(switchToResolvedAssistantMock).not.toHaveBeenCalled();

    act(() => {
      useResolvedAssistantsStore.setState({
        assistants: [ASSISTANT_A, ASSISTANT_B],
        assistantsHydrated: true,
      });
    });
    await pendingTap;

    expect(switchToResolvedAssistantMock).toHaveBeenCalledWith(ASSISTANT_A);
    expect(received).toEqual([{ threadId: "conv-cold" }]);
  });

  test("waits for the platform organization owner before validating", async () => {
    const identity = platformIdentity(ASSISTANT_A);
    useOrganizationStore.setState({
      currentOrganizationId: null,
      persistedOrganizationId: null,
      status: "loading",
    });
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();
    const handler = capturedHandler;
    if (!handler) {
      throw new Error("expected notification tap handler");
    }

    const pendingTap = Promise.resolve(
      handler({
        conversationId: "conv-org",
        sourceEventName: "reminder.fired",
        identity,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(switchToResolvedAssistantMock).not.toHaveBeenCalled();

    act(() => {
      useOrganizationStore.setState({
        currentOrganizationId: "org-1",
        persistedOrganizationId: "org-1",
        status: "ready",
      });
    });
    await pendingTap;

    expect(switchToResolvedAssistantMock).toHaveBeenCalledWith(ASSISTANT_A);
    expect(received).toEqual([{ threadId: "conv-org" }]);
  });

  test("does not wait for organization state for a local target", async () => {
    const localAssistant: ResolvedAssistant = {
      id: "local-a",
      runtimeUrl: "https://assistant.example.com",
      isLocal: true,
      isPlatformHosted: false,
      isPaired: false,
    };
    const scopeId = resolveAssistantAvatarOwnerScopeId(
      localAssistant,
      null,
      null,
      window.location.href,
    );
    const identity = scopeId
      ? createNotificationIdentity(scopeId, localAssistant.id, null)
      : null;
    if (!identity) {
      throw new Error("expected local notification identity");
    }
    useOrganizationStore.setState({
      currentOrganizationId: null,
      persistedOrganizationId: null,
      status: "loading",
    });
    useResolvedAssistantsStore.setState({
      assistants: [localAssistant],
      assistantsHydrated: true,
    });
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-local",
      sourceEventName: "reminder.fired",
      identity,
    });

    expect(switchToResolvedAssistantMock).toHaveBeenCalledWith(localAssistant);
    expect(received).toEqual([{ threadId: "conv-local" }]);
  });

  test("drops the tap when switching the scoped assistant fails", async () => {
    switchToResolvedAssistantMock.mockRejectedValueOnce(
      new Error("connection failed"),
    );
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-failed",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });

    expect(received).toEqual([]);
    expect(sentryBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "tap_assistant_switch_failed" }),
    );
  });
});
