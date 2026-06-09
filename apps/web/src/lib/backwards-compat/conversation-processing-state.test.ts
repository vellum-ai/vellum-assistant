import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useActiveConversationIsProcessing } from "@/lib/backwards-compat/conversation-processing-state";
import { conversationsQueryKey } from "@/lib/sync/query-tags";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { Conversation } from "@/types/conversation-types";

const ASSISTANT_ID = "test-asst";
const CONVERSATION_ID = "conv-1";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity(ASSISTANT_ID, version);
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

/**
 * Render the hook with the active conversation wired up through the same
 * stores and query cache the production hook reads: the daemon's
 * `isProcessing` flag is seeded onto the cached conversation row, and the
 * client optimistic mirror is toggled via `conversation-store`.
 */
async function isProcessing(inputs: {
  serverIsProcessing: boolean | undefined;
  isMarkedProcessingLocally: boolean;
}): Promise<boolean> {
  // Each render starts from a clean processing mirror so repeated calls in one
  // test reflect exactly the inputs given (the version set by `setVersion` is
  // intentionally preserved).
  useConversationStore.getState().reset();
  useResolvedAssistantsStore.getState().clear();

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData<Conversation[]>(conversationsQueryKey(ASSISTANT_ID), [
    {
      conversationId: CONVERSATION_ID,
      isProcessing: inputs.serverIsProcessing,
    } as Conversation,
  ]);

  useResolvedAssistantsStore.getState().setActiveAssistantId(ASSISTANT_ID);
  useConversationStore.getState().setActiveConversationId(CONVERSATION_ID);
  if (inputs.isMarkedProcessingLocally) {
    useConversationStore.getState().markConversationProcessing(CONVERSATION_ID);
  }

  const { result, unmount } = renderHook(
    () => useActiveConversationIsProcessing(),
    { wrapper: createWrapper(queryClient) },
  );
  const value = result.current;

  // Flush the query observers' batched post-mount notification (React Query's
  // `notifyManager` schedules it on a timer) and unmount inside `act`, so the
  // late update has no mounted target and never surfaces as an unwrapped
  // update warning. The cache is seeded before the render, so `value` is
  // already final.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    unmount();
  });
  return value;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
  useConversationStore.getState().reset();
  useResolvedAssistantsStore.getState().clear();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
  useConversationStore.getState().reset();
  useResolvedAssistantsStore.getState().clear();
});

// Exhaustive truth-table for the underlying semver gate lives in
// `utils.test.ts`. Here we verify the processing-source branch on each
// side of the 0.8.8 boundary plus the conservative-on-unknown policy.
describe("useActiveConversationIsProcessing", () => {
  test("on 0.8.8+, the server flag is the single source of truth", async () => {
    // GIVEN an assistant new enough to surface `isProcessing` reliably
    setVersion("0.8.8");

    // WHEN the server reports processing
    // THEN the conversation is processing regardless of the client mirror
    expect(
      await isProcessing({
        serverIsProcessing: true,
        isMarkedProcessingLocally: false,
      }),
    ).toBe(true);

    // AND when the server reports NOT processing, a stale client mirror
    // can no longer keep the indicator stuck on — this is the bug fix.
    expect(
      await isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);

    // AND a missing server flag is treated as not processing.
    expect(
      await isProcessing({
        serverIsProcessing: undefined,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);
  });

  test("on 0.8.8+, newer versions also trust the server flag alone", async () => {
    // GIVEN assistants well past the cutover
    // WHEN the server reports NOT processing but the mirror is stale
    // THEN the stale mirror is ignored
    setVersion("0.9.0");
    expect(
      await isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);

    setVersion("1.0.0");
    expect(
      await isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);
  });

  test("treats RC builds of the cutover patch as trusting the server flag", async () => {
    // GIVEN an RC build of the cutover patch, which ships the same
    // freshness handlers as the final 0.8.8
    setVersion("0.8.8-rc.1");

    // WHEN the server reports NOT processing but the mirror is stale
    // THEN RC testers get the server-only behavior
    expect(
      await isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);

    setVersion("0.8.8-beta");
    expect(
      await isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(false);
  });

  test("on 0.8.7 and older, falls back to OR-ing the client mirror", async () => {
    // GIVEN an assistant that may omit `isProcessing` on the wire
    // WHEN only the client mirror marks the conversation as processing
    // THEN the legacy belt-and-suspenders fallback keeps it processing
    for (const version of ["0.8.7", "0.8.0", "0.7.0"]) {
      setVersion(version);
      expect(
        await isProcessing({
          serverIsProcessing: false,
          isMarkedProcessingLocally: true,
        }),
      ).toBe(true);

      // AND the server flag still wins when it is the one set
      expect(
        await isProcessing({
          serverIsProcessing: true,
          isMarkedProcessingLocally: false,
        }),
      ).toBe(true);

      // AND when neither source is set, the conversation is not processing
      expect(
        await isProcessing({
          serverIsProcessing: false,
          isMarkedProcessingLocally: false,
        }),
      ).toBe(false);
    }
  });

  test("conservatively falls back to OR when the version is unknown", async () => {
    // GIVEN the identity store has not hydrated a version yet
    setVersion(null);

    // WHEN only the client mirror marks the conversation as processing
    // THEN we keep the legacy OR until the version resolves, so a turn
    // in flight before hydration never loses its indicator
    expect(
      await isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(true);
  });

  test("conservatively falls back to OR for unparseable versions", async () => {
    // GIVEN a version string semver can't parse
    // WHEN only the client mirror marks the conversation as processing
    // THEN we fall back to the legacy OR rather than trusting an
    // unverifiable version
    setVersion("garbage");
    expect(
      await isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(true);

    setVersion("0.8");
    expect(
      await isProcessing({
        serverIsProcessing: false,
        isMarkedProcessingLocally: true,
      }),
    ).toBe(true);
  });
});
