/**
 * Post-reconnect attention sweep: when the bus-owned SSE connection
 * reopens after a transport hiccup (watchdog / error / resume), refetch
 * the bulk pending-interactions snapshot and reconcile sidebar state.
 *
 * A fresh first-open is owned by the initial-sweep effect — the
 * reconnect handler must not double-fire on `cause === "fresh"`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import * as sdkGen from "@/generated/daemon/sdk.gen";
import { useConversationStore } from "@/stores/conversation-store";
import {
  __resetForTesting,
  publish,
} from "@/lib/event-bus";

// Stub the conversation-list query and the mark-seen endpoint so the
// hook does not try to hit a real backend during renderHook.
mock.module("@/hooks/conversation-queries", () => ({
  useConversationListQuery: () => ({ conversations: [] }),
  useBackgroundConversationListQuery: () => ({ conversations: [] }),
  useScheduledConversationListQuery: () => ({ conversations: [] }),
}));

mock.module("@/utils/conversation-cache-mutations", () => ({
  markConversationSeenLocal: () => {},
  refreshConversationRow: async () => {},
  prependConversation: () => {},
  removeConversation: () => {},
  resolveDraftKey: () => {},
}));

mock.module("@/utils/conversation-cache", () => ({
  getConversations: () => [],
  findConversation: () => undefined,
}));

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkGen,
  conversationsSeenPost: async () => ({ data: undefined, error: undefined, response: { ok: true } }),
}));

// Per-test override slot for the bulk fetch. `mock.module` calls in bun
// pollute every other test file that imports the same module, so we must
// re-declare every export from `@/domains/chat/api/interactions.js`
// (not just the one we drive). The non-driven exports throw a pointer
// back to this file so cross-suite leakage is loud and easy to diagnose.
type BulkFetchImpl = (assistantId: string) => Promise<Set<string>>;
const bulkFetch: { current: BulkFetchImpl } = {
  current: async () => new Set<string>(),
};

const stubFromOtherTest = (name: string) => () => {
  throw new Error(
    `[reconnect-sweep test] ${name} called via a leaked mock.module — ` +
      "another test file is sharing this stub. Re-mock it in the test " +
      "that needs it (see apps/web/src/domains/conversations/" +
      "use-attention-tracking-reconnect-sweep.test.tsx).",
  );
};

mock.module("@/domains/chat/api/interactions", () => ({
  listConversationIdsWithPendingInteractions: (assistantId: string) =>
    bulkFetch.current(assistantId),
  // Other exports of the module — stubbed loudly so a stale leak surfaces.
  getPendingInteractions: stubFromOtherTest("getPendingInteractions"),
  submitSecretResponse: stubFromOtherTest("submitSecretResponse"),
  submitConfirmation: stubFromOtherTest("submitConfirmation"),
  submitContactPrompt: stubFromOtherTest("submitContactPrompt"),
  submitQuestionResponse: stubFromOtherTest("submitQuestionResponse"),
  submitTrustRule: stubFromOtherTest("submitTrustRule"),
}));

const { useAttentionTracking } = await import(
  "@/domains/chat/hooks/use-attention-tracking"
);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function publishOpened(cause: "fresh" | "error" | "watchdog" | "resume") {
  publish("sse.opened", {
    assistantId: "asst-1",
    cause,
  });
}

function mountHook() {
  return renderHook(
    () =>
      useAttentionTracking({
        assistantId: "asst-1",
        assistantStateKind: "active",
      }),
    { wrapper },
  );
}

beforeEach(() => {
  __resetForTesting();
  useConversationStore.getState().reset();
  bulkFetch.current = async () => new Set<string>();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  useConversationStore.getState().reset();
});

describe("useAttentionTracking — post-reconnect sweep", () => {
  test("does NOT run when cause is 'fresh' (initial-sweep effect handles it)", async () => {
    let calls = 0;
    bulkFetch.current = async () => {
      calls += 1;
      return new Set<string>();
    };

    useConversationStore.getState().addAttentionConversationId("conv-stale");
    mountHook();

    // The initial-sweep effect fires once on mount with an empty
    // conversation list (see the stubbed `useConversationListQuery`)
    // and therefore short-circuits before invoking the fetch. Reset
    // the counter to isolate what the `sse.opened` handler does.
    await waitFor(() => {
      // Allow any mount microtasks to settle.
      expect(true).toBe(true);
    });
    calls = 0;

    publishOpened("fresh");

    // Yield twice — once for the publish microtask, once for any
    // awaited fetch that could have been scheduled.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(0);
    // And attentionConversationIds are untouched (no reconciliation ran).
    expect(
      useConversationStore.getState().attentionConversationIds.has("conv-stale"),
    ).toBe(true);
  });

  for (const cause of ["watchdog", "error", "resume"] as const) {
    test(`runs the sweep when cause is '${cause}' and reconciles attention/processing keys`, async () => {
      // Pre-populate sidebar state:
      //  - conv-stale: in attentionConversationIds but no longer pending → must be removed
      //  - conv-promote: in processingConversationIds AND still pending → must be promoted to attentionConversationIds
      //  - conv-new: not tracked at all but pending → must be added to attentionConversationIds
      //  - conv-active: active key — must NEVER be mutated by the sweep
      useConversationStore.getState().setActiveConversationId("conv-active");
      useConversationStore.getState().addAttentionConversationId("conv-stale");
      useConversationStore.getState().addAttentionConversationId("conv-active");
      useConversationStore.getState().addProcessingConversationId("conv-promote");
      useConversationStore.getState().addProcessingConversationId("conv-active");

      bulkFetch.current = async () =>
        new Set(["conv-promote", "conv-new", "conv-active"]);

      mountHook();
      publishOpened(cause);

      await waitFor(() => {
        expect(
          useConversationStore.getState().attentionConversationIds.has("conv-new"),
        ).toBe(true);
      });

      const state = useConversationStore.getState();
      // Stale attention removed.
      expect(state.attentionConversationIds.has("conv-stale")).toBe(false);
      // Promoted: now in attention, removed from processing.
      expect(state.attentionConversationIds.has("conv-promote")).toBe(true);
      expect(state.processingConversationIds.has("conv-promote")).toBe(false);
      // Newly-pending conversation added to attention.
      expect(state.attentionConversationIds.has("conv-new")).toBe(true);
      // Active conversation untouched in both sets, regardless of the
      // fetch payload — the sweep must skip it.
      expect(state.attentionConversationIds.has("conv-active")).toBe(true);
      expect(state.processingConversationIds.has("conv-active")).toBe(true);
    });
  }

  test("silently no-ops when the bulk fetch throws", async () => {
    useConversationStore.getState().addAttentionConversationId("conv-stale");
    useConversationStore.getState().addProcessingConversationId("conv-promote");

    let invoked = 0;
    bulkFetch.current = async () => {
      invoked += 1;
      throw new Error("network down");
    };

    mountHook();
    publishOpened("watchdog");

    await waitFor(() => {
      expect(invoked).toBe(1);
    });

    // Yield one more tick so any (incorrect) follow-up dispatches would
    // have landed before we assert.
    await Promise.resolve();

    // Sidebar state untouched — keys stay until the next successful sweep.
    const state = useConversationStore.getState();
    expect(state.attentionConversationIds.has("conv-stale")).toBe(true);
    expect(state.processingConversationIds.has("conv-promote")).toBe(true);
  });
});
