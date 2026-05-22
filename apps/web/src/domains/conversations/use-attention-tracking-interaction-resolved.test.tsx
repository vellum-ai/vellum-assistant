/**
 * Push-based attention reconciliation: an `interaction_resolved` SSE event
 * removes the resolved conversation from both `attentionKeys` and
 * `processingKeys` without any HTTP polling.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import { useConversationStore } from "@/domains/conversations/conversation-store.js";
import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store.js";

// The hook fetches the conversation list and runs an initial sweep; stub
// both so renderHook does not try to hit a real backend.
mock.module("@/domains/conversations/conversation-queries.js", () => ({
  useConversationListQuery: () => ({ conversations: [] }),
  getConversations: () => [],
  findConversation: () => undefined,
  markConversationSeenLocal: () => {},
}));

mock.module("@/domains/chat/api/conversations.js", () => ({
  markConversationSeen: async () => {},
}));

mock.module("@/domains/chat/api/interactions.js", () => ({
  listConversationKeysWithPendingInteractions: async () => new Set<string>(),
}));

const { useAttentionTracking } = await import(
  "@/domains/conversations/use-attention-tracking.js"
);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function publishInteractionResolved(payload: {
  requestId: string;
  conversationId: string;
  state: "approved" | "rejected" | "answered" | "cancelled" | "superseded";
  kind?: string;
}) {
  act(() => {
    useEventBusStore.getState().publish("sse.event", {
      type: "interaction_resolved",
      requestId: payload.requestId,
      conversationId: payload.conversationId,
      state: payload.state,
      // Cast through the daemon-mirrored union; tests intentionally feed
      // both user-facing and host-proxy kinds.
      kind: (payload.kind ?? "confirmation") as
        | "confirmation"
        | "secret"
        | "question"
        | "acp_confirmation"
        | "host_bash"
        | "host_file"
        | "host_cu"
        | "host_browser"
        | "host_app_control"
        | "host_transfer",
    });
  });
}

beforeEach(() => {
  __resetEventBusForTesting();
  useConversationStore.getState().reset();
});

afterEach(() => {
  cleanup();
  __resetEventBusForTesting();
  useConversationStore.getState().reset();
});

describe("useAttentionTracking — interaction_resolved subscriber", () => {
  test("removes the conversation from attentionKeys", () => {
    useConversationStore.getState().addAttentionKey("conv-1");
    expect(useConversationStore.getState().attentionKeys.has("conv-1")).toBe(true);

    renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    publishInteractionResolved({
      requestId: "req-1",
      conversationId: "conv-1",
      state: "approved",
    });

    expect(useConversationStore.getState().attentionKeys.has("conv-1")).toBe(false);
  });

  test("removes the conversation from processingKeys", () => {
    useConversationStore.getState().addProcessingKey("conv-2");
    expect(useConversationStore.getState().processingKeys.has("conv-2")).toBe(true);

    renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    publishInteractionResolved({
      requestId: "req-2",
      conversationId: "conv-2",
      state: "answered",
      kind: "secret",
    });

    expect(useConversationStore.getState().processingKeys.has("conv-2")).toBe(
      false,
    );
  });

  test("does not touch the active conversation", () => {
    useConversationStore.getState().setActiveKey("conv-active");
    useConversationStore.getState().addAttentionKey("conv-active");

    renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    publishInteractionResolved({
      requestId: "req-3",
      conversationId: "conv-active",
      state: "approved",
    });

    // Active conversation keeps its attention badge — the open chat view
    // owns the bubble lifecycle directly.
    expect(
      useConversationStore.getState().attentionKeys.has("conv-active"),
    ).toBe(true);
  });

  test("ignores events with an empty conversationId", () => {
    useConversationStore.getState().addAttentionKey("conv-7");

    renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    publishInteractionResolved({
      requestId: "req-7",
      conversationId: "",
      state: "cancelled",
    });

    expect(useConversationStore.getState().attentionKeys.has("conv-7")).toBe(
      true,
    );
  });

  test("superseded state also clears attention", () => {
    useConversationStore.getState().addAttentionKey("conv-super");

    renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    publishInteractionResolved({
      requestId: "req-super",
      conversationId: "conv-super",
      state: "superseded",
    });

    expect(
      useConversationStore.getState().attentionKeys.has("conv-super"),
    ).toBe(false);
  });

  test("only clears state for kinds in the user-facing allowlist (host-proxy and unknown future kinds are ignored)", () => {
    useConversationStore.getState().addProcessingKey("conv-host");
    expect(
      useConversationStore.getState().processingKeys.has("conv-host"),
    ).toBe(true);

    renderHook(
      () =>
        useAttentionTracking({
          assistantId: "asst-1",
          assistantStateKind: "active",
        }),
      { wrapper },
    );

    // Host-proxy kinds resolve as intermediate tool steps mid-turn and
    // must not clear the processing indicator. A hypothetical future
    // intermediate kind without a `host_` prefix must also be ignored —
    // the subscriber filters by an explicit allowlist, not by name shape.
    for (const kind of [
      "host_bash",
      "host_file",
      "host_cu",
      "host_browser",
      "host_app_control",
      "host_transfer",
      "future_intermediate_step",
    ]) {
      publishInteractionResolved({
        requestId: `req-${kind}`,
        conversationId: "conv-host",
        state: "answered",
        kind,
      });
    }

    expect(
      useConversationStore.getState().processingKeys.has("conv-host"),
    ).toBe(true);
  });

  test("unsubscribes when assistantId becomes null", () => {
    useConversationStore.getState().addAttentionKey("conv-detach");

    const { rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useAttentionTracking({
          assistantId: id,
          assistantStateKind: "active",
        }),
      { wrapper, initialProps: { id: "asst-1" } as { id: string | null } },
    );

    rerender({ id: null });

    // After unsubscribe, the event-resolved subscriber must not fire.
    publishInteractionResolved({
      requestId: "req-detach",
      conversationId: "conv-detach",
      state: "approved",
    });

    expect(
      useConversationStore.getState().attentionKeys.has("conv-detach"),
    ).toBe(true);
  });
});
