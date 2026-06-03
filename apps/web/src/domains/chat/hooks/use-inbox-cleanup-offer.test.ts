import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

const INBOX_CLEANUP_TASK_ID = "inbox-cleanup";
const CONVERSATION_ID = "conv-onboarding";
const ASSISTANT_ID = "asst-1";
const REQUEST_ID = "req-test-1";

const greeting: DisplayMessage[] = [{ id: "m1", role: "assistant" }];

// --- Controllable mocks for the generated OAuth API ------------------------

// Google connection state returned by the connections query. Tests flip this.
let googleConnected = false;

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsOauthConnectionsListOptions: ({
    path,
  }: {
    path: { assistant_id: string };
  }) => ({
    queryKey: ["oauth-connections", path.assistant_id],
    queryFn: async () =>
      googleConnected
        ? [{ provider: "google", connected: true, scopes_granted: [] }]
        : [],
  }),
  // Returned shape only needs to satisfy `useMutation({ ...mutation() })`.
  // `mutationFn` resolves a fake connect_url; the popup never navigates in tests.
  assistantsOauthStartCreateMutation: () => ({
    mutationFn: async () => ({ connect_url: "https://example.test/oauth" }),
  }),
}));

// Force the web (popup) path, never native.
mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => false,
}));

// Bypass origin checks so tests can drive completion via a plain message event.
mock.module("@/lib/auth/oauth-popup", () => ({
  oauthCompletionStorageKey: (requestId: string) =>
    `vellum:oauth-complete:${requestId}`,
  isOAuthCompletePayloadForRequest: () => false,
  getOAuthCompleteMessagePayload: (event: MessageEvent) => event.data,
  getOAuthCompleteStoragePayload: () => null,
}));

const { useInboxCleanupOffer } = await import(
  "@/domains/chat/hooks/use-inbox-cleanup-offer"
);

interface OverrideOptions {
  didOnboarding?: boolean;
  firstTask?: string | null;
  activationFlowEnabled?: boolean;
  messages?: DisplayMessage[];
  activeConversationId?: string | null;
  onboardingConversationId?: string | null;
  assistantId?: string | null;
  sendMessage?: (content: string) => void;
}

function baseOptions(overrides: OverrideOptions = {}) {
  return {
    didOnboarding: overrides.didOnboarding ?? true,
    firstTask:
      overrides.firstTask === undefined
        ? INBOX_CLEANUP_TASK_ID
        : overrides.firstTask,
    activationFlowEnabled: overrides.activationFlowEnabled ?? true,
    messages: overrides.messages ?? greeting,
    activeConversationId:
      overrides.activeConversationId === undefined
        ? CONVERSATION_ID
        : overrides.activeConversationId,
    onboardingConversationId:
      overrides.onboardingConversationId === undefined
        ? CONVERSATION_ID
        : overrides.onboardingConversationId,
    assistantId:
      overrides.assistantId === undefined ? ASSISTANT_ID : overrides.assistantId,
    sendMessage: overrides.sendMessage ?? (() => {}),
  };
}

function withQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

// A fake popup whose `location.href` setter is inert, so happy-dom never tries
// to actually navigate (and fetch) the connect URL.
function makeFakePopup(): Window {
  return {
    closed: false,
    close() {
      (this as { closed: boolean }).closed = true;
    },
    location: { href: "" },
  } as unknown as Window;
}

function dispatchOAuthComplete(oauthStatus: string) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "vellum:oauth-complete",
          requestId: REQUEST_ID,
          oauthStatus,
          oauthProvider: "google",
        },
      }),
    );
  });
}

const realWindowOpen = window.open;

beforeEach(() => {
  googleConnected = false;
  // Deterministic request id so dispatched completion events match.
  crypto.randomUUID = (() =>
    REQUEST_ID) as unknown as typeof crypto.randomUUID;
  // Return an inert popup so happy-dom never navigates the connect URL.
  window.open = (() => makeFakePopup()) as typeof window.open;
});

afterEach(() => {
  cleanup();
  window.open = realWindowOpen;
});

describe("useInboxCleanupOffer", () => {
  test("hidden when the activation flag is off", () => {
    const { result } = renderHook(
      () => useInboxCleanupOffer(baseOptions({ activationFlowEnabled: false })),
      { wrapper: withQueryClient() },
    );
    expect(result.current.showInboxOffer).toBe(false);
  });

  test("hidden when firstTask does not match inbox-cleanup", () => {
    const { result } = renderHook(
      () => useInboxCleanupOffer(baseOptions({ firstTask: "something-else" })),
      { wrapper: withQueryClient() },
    );
    expect(result.current.showInboxOffer).toBe(false);
  });

  test("hidden when the assistant greeting has not arrived", () => {
    const { result } = renderHook(
      () =>
        useInboxCleanupOffer(
          baseOptions({ messages: [{ id: "u1", role: "user" }] }),
        ),
      { wrapper: withQueryClient() },
    );
    expect(result.current.showInboxOffer).toBe(false);
  });

  test("hidden when not on the onboarding conversation", () => {
    const { result } = renderHook(
      () => useInboxCleanupOffer(baseOptions({ activeConversationId: "other" })),
      { wrapper: withQueryClient() },
    );
    expect(result.current.showInboxOffer).toBe(false);
  });

  test("shown when all conditions are met", () => {
    const { result } = renderHook(() => useInboxCleanupOffer(baseOptions()), {
      wrapper: withQueryClient(),
    });
    expect(result.current.showInboxOffer).toBe(true);
  });

  test("already connected: sends run message immediately, no popup", async () => {
    googleConnected = true;
    const openSpy = mock(() => makeFakePopup());
    window.open = openSpy as typeof window.open;
    const sendMessage = mock((_content: string) => {});

    const { result } = renderHook(
      () => useInboxCleanupOffer(baseOptions({ sendMessage })),
      { wrapper: withQueryClient() },
    );
    expect(result.current.showInboxOffer).toBe(true);

    act(() => {
      result.current.handleAccept();
    });
    // accepting flips synchronously so both buttons disable immediately.
    expect(result.current.accepting).toBe(true);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(openSpy).not.toHaveBeenCalled();
    expect(result.current.showInboxOffer).toBe(false);
  });

  test("not connected: starts OAuth, runs only after success", async () => {
    googleConnected = false;
    const sendMessage = mock((_content: string) => {});

    const { result } = renderHook(
      () => useInboxCleanupOffer(baseOptions({ sendMessage })),
      { wrapper: withQueryClient() },
    );
    expect(result.current.showInboxOffer).toBe(true);

    act(() => {
      result.current.handleAccept();
    });

    // Connecting: buttons disabled, card still up, nothing sent yet.
    await waitFor(() => {
      expect(result.current.accepting).toBe(true);
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.showInboxOffer).toBe(true);

    dispatchOAuthComplete("connected");

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(result.current.showInboxOffer).toBe(false);
  });

  test("not connected then cancel: re-shows card, sends nothing", async () => {
    googleConnected = false;
    const sendMessage = mock((_content: string) => {});

    const { result } = renderHook(
      () => useInboxCleanupOffer(baseOptions({ sendMessage })),
      { wrapper: withQueryClient() },
    );

    act(() => {
      result.current.handleAccept();
    });
    await waitFor(() => {
      expect(result.current.accepting).toBe(true);
    });

    // Non-"connected" status models a cancel/failure.
    dispatchOAuthComplete("cancelled");

    await waitFor(() => {
      expect(result.current.accepting).toBe(false);
    });
    expect(sendMessage).not.toHaveBeenCalled();
    // Card stays visible so the user can retry.
    expect(result.current.showInboxOffer).toBe(true);
  });

  test("handleDecline hides the card without sending", () => {
    const sendMessage = mock((_content: string) => {});
    const { result } = renderHook(
      () => useInboxCleanupOffer(baseOptions({ sendMessage })),
      { wrapper: withQueryClient() },
    );
    expect(result.current.showInboxOffer).toBe(true);

    act(() => {
      result.current.handleDecline();
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.current.showInboxOffer).toBe(false);
    expect(result.current.accepting).toBe(false);
  });

  test("dismissed card never reappears", () => {
    const { result } = renderHook(() => useInboxCleanupOffer(baseOptions()), {
      wrapper: withQueryClient(),
    });
    expect(result.current.showInboxOffer).toBe(true);

    act(() => {
      result.current.handleDecline();
    });
    expect(result.current.showInboxOffer).toBe(false);
  });
});
