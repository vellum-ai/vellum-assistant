/**
 * Send-path wiring for per-chat plugin selection (PR 14).
 *
 * Mirrors the `inferenceProfile` stash lifecycle: an EXPLICIT plugin
 * selection stashed for a draft conversation rides along on the first
 * `POST /messages`, sorted to a stable array, gated on resolved daemon
 * support, and cleared from the stash once the send succeeds.
 *
 * The hook is driven end-to-end against a spied daemon client (no
 * `mock.module`, so the module registry stays clean for sibling test
 * files). The scope check intentionally fails — the active assistant /
 * conversation are left unset — so `sendMessageViaStream` returns right
 * after the attach + clear, skipping the stream/poll machinery this PR
 * does not touch.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useSendMessage } from "@/domains/chat/hooks/use-send-message";
import { useConversationStore } from "@/stores/conversation-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useTurnStore, INITIAL_TURN_STATE } from "@/domains/chat/turn-store";
import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-new-chat-plugins";

const DRAFT_ID = "draft-1";

let capturedBody: Record<string, unknown> | null = null;
const originalPost = daemonClient.post;

const queryClient = new QueryClient();
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function baseProps() {
  return {
    assistantId: "assistant-1",
    activeConversationId: DRAFT_ID,
    diskPressureChatBlockReason: null,
    uiContextRef: { current: null },
    pendingOnboardingContextRef: { current: null },
    onboardingDraftConversationIdRef: { current: null },
    startReconciliationLoop: () => {},
    cancelReconciliation: () => {},
    refreshConversations: async () => {},
  };
}

async function send(version: string) {
  useAssistantIdentityStore.getState().setIdentity("Assistant", version);
  const props = baseProps();
  const { result } = renderHook(() => useSendMessage(props), {
    wrapper: Wrapper,
  });
  await act(async () => {
    await result.current.sendMessage("hi");
  });
}

beforeEach(() => {
  capturedBody = null;
  queryClient.clear();
  useConversationStore.getState().reset();
  useTurnStore.setState(INITIAL_TURN_STATE);
  useChatSessionStore.getState().setOptimisticSends([]);
  useChatSessionStore.getState().setError(null);
  // Leave the active assistant/conversation unset so the post-send scope
  // check returns false and the hook stops right after attach + clear.
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);

  daemonClient.post = mock(
    async (options: { body?: Record<string, unknown> }) => {
      capturedBody = options.body ?? null;
      return {
        data: { accepted: true, conversationId: "conv-real", messageId: "m1" },
        error: null,
        response: new Response(null, { status: 200 }),
      };
    },
  ) as typeof daemonClient.post;
});

afterEach(() => {
  daemonClient.post = originalPost;
  cleanup();
});

describe("useSendMessage — enabledPlugins send wiring", () => {
  test("attaches the sorted explicit selection and clears the stash on success", async () => {
    useConversationStore
      .getState()
      .setPendingDraftPlugins(DRAFT_ID, new Set(["zeta", "alpha"]));

    await send(MIN_VERSION);

    expect((capturedBody as Record<string, unknown>).enabledPlugins).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(
      useConversationStore.getState().pendingDraftPlugins.has(DRAFT_ID),
    ).toBe(false);
  });

  test("omits enabledPlugins when no explicit selection exists (untouched default)", async () => {
    await send(MIN_VERSION);

    expect(
      (capturedBody as Record<string, unknown>).enabledPlugins,
    ).toBeUndefined();
  });

  test("never attaches on an unsupported daemon but still clears the stash", async () => {
    useConversationStore
      .getState()
      .setPendingDraftPlugins(DRAFT_ID, new Set(["alpha"]));

    // 0.10.3 is below MIN_VERSION (0.10.4) — the daemon would silently drop
    // the field, so the gate must omit it. The stash is still cleared because
    // the conversation was created.
    await send("0.10.3");

    expect(
      (capturedBody as Record<string, unknown>).enabledPlugins,
    ).toBeUndefined();
    expect(
      useConversationStore.getState().pendingDraftPlugins.has(DRAFT_ID),
    ).toBe(false);
  });
});
