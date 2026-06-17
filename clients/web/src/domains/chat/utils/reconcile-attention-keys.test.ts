/**
 * Unit tests for reconcileAttentionKeys — a pure async function that
 * reconciles sidebar attention/processing state against the daemon's
 * pending-interactions snapshot.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { useConversationStore } from "@/stores/conversation-store";
import { useSidebarCollapseStore } from "@/domains/chat/sidebar-collapse-store";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

let pendingKeysImpl: () => Promise<Set<string>> = async () => new Set();
let conversationsImpl: Array<{ conversationId: string }> = [];

mock.module("@/domains/chat/api/interactions", () => ({
  listConversationIdsWithPendingInteractions: (_assistantId: string) =>
    pendingKeysImpl(),
}));

mock.module("@/utils/conversation-cache", () => ({
  getConversations: () => conversationsImpl,
}));

const { reconcileAttentionKeys } = await import(
  "@/domains/chat/utils/reconcile-attention-keys"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient();
  useConversationStore.getState().reset();
  pendingKeysImpl = async () => new Set();
  conversationsImpl = [];
});

afterEach(() => {
  useConversationStore.getState().reset();
});

describe("reconcileAttentionKeys", () => {
  test("adds pending keys to attention set", async () => {
    pendingKeysImpl = async () => new Set(["conv-1", "conv-2"]);
    conversationsImpl = [
      { conversationId: "conv-1" },
      { conversationId: "conv-2" },
    ];

    await reconcileAttentionKeys("asst-1", queryClient);

    const state = useConversationStore.getState();
    expect(state.attentionConversationIds.has("conv-1")).toBe(true);
    expect(state.attentionConversationIds.has("conv-2")).toBe(true);
  });

  test("skips the active conversation", async () => {
    useConversationStore.getState().setActiveConversationId("conv-active");
    pendingKeysImpl = async () => new Set(["conv-active", "conv-other"]);
    conversationsImpl = [
      { conversationId: "conv-active" },
      { conversationId: "conv-other" },
    ];

    await reconcileAttentionKeys("asst-1", queryClient);

    const state = useConversationStore.getState();
    expect(state.attentionConversationIds.has("conv-active")).toBe(false);
    expect(state.attentionConversationIds.has("conv-other")).toBe(true);
  });

  test("does not duplicate keys already in attention", async () => {
    useConversationStore.getState().addAttentionConversationId("conv-1");
    pendingKeysImpl = async () => new Set(["conv-1"]);
    conversationsImpl = [{ conversationId: "conv-1" }];

    await reconcileAttentionKeys("asst-1", queryClient);

    const state = useConversationStore.getState();
    expect(state.attentionConversationIds.has("conv-1")).toBe(true);
  });

  test("does not add keys already in processing set", async () => {
    useConversationStore.getState().addProcessingConversationId("conv-1");
    pendingKeysImpl = async () => new Set(["conv-1"]);
    conversationsImpl = [{ conversationId: "conv-1" }];

    await reconcileAttentionKeys("asst-1", queryClient);

    const state = useConversationStore.getState();
    // Stays in processing, not duplicated to attention.
    expect(state.processingConversationIds.has("conv-1")).toBe(true);
    expect(state.attentionConversationIds.has("conv-1")).toBe(false);
  });

  test("with pruneStale: removes stale attention keys not in pending", async () => {
    useConversationStore.getState().addAttentionConversationId("conv-stale");
    useConversationStore.getState().addAttentionConversationId("conv-valid");
    pendingKeysImpl = async () => new Set(["conv-valid"]);
    conversationsImpl = [
      { conversationId: "conv-stale" },
      { conversationId: "conv-valid" },
    ];

    await reconcileAttentionKeys("asst-1", queryClient, { pruneStale: true });

    const state = useConversationStore.getState();
    expect(state.attentionConversationIds.has("conv-stale")).toBe(false);
    expect(state.attentionConversationIds.has("conv-valid")).toBe(true);
  });

  test("with pruneStale: promotes processing keys that are still pending", async () => {
    useConversationStore.getState().addProcessingConversationId("conv-promote");
    pendingKeysImpl = async () => new Set(["conv-promote"]);
    conversationsImpl = [{ conversationId: "conv-promote" }];

    await reconcileAttentionKeys("asst-1", queryClient, { pruneStale: true });

    const state = useConversationStore.getState();
    expect(state.attentionConversationIds.has("conv-promote")).toBe(true);
    expect(state.processingConversationIds.has("conv-promote")).toBe(false);
  });

  test("with pruneStale: never prunes the active conversation", async () => {
    useConversationStore.getState().setActiveConversationId("conv-active");
    useConversationStore.getState().addAttentionConversationId("conv-active");
    pendingKeysImpl = async () => new Set(); // active is NOT pending
    conversationsImpl = [{ conversationId: "conv-active" }];

    await reconcileAttentionKeys("asst-1", queryClient, { pruneStale: true });

    const state = useConversationStore.getState();
    // Active key is preserved even though it's not in the pending set.
    expect(state.attentionConversationIds.has("conv-active")).toBe(true);
  });

  test("reveals lazy sidebar sections when pending key is not loaded", async () => {
    pendingKeysImpl = async () => new Set(["conv-unloaded"]);
    // conv-unloaded is NOT in the conversations list (not loaded).
    conversationsImpl = [{ conversationId: "conv-other" }];

    await reconcileAttentionKeys("asst-1", queryClient);

    expect(useSidebarCollapseStore.getState().backgroundActivated).toBe(true);
  });

  test("silently no-ops when the fetch throws", async () => {
    useConversationStore.getState().addAttentionConversationId("conv-keep");
    pendingKeysImpl = async () => {
      throw new Error("network failure");
    };

    await reconcileAttentionKeys("asst-1", queryClient, { pruneStale: true });

    // State unchanged — the function returned early.
    const state = useConversationStore.getState();
    expect(state.attentionConversationIds.has("conv-keep")).toBe(true);
  });
});
