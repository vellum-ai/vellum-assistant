/**
 * Tests for `useTurnTimeout`, the watchdog that terminates a turn whose stream
 * has gone completely silent.
 *
 * bun:test ships no fake-timer API, so the hook's `timeoutMs` override drives
 * the watchdog on a millisecond scale with real timers.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { INITIAL_TURN_STATE, useTurnStore } from "@/domains/chat/turn-store";
import {
  TURN_SILENCE_TIMEOUT_MS,
  useTurnTimeout,
} from "@/domains/chat/hooks/use-turn-timeout";
import { useConversationStore } from "@/stores/conversation-store";

const TEST_TIMEOUT_MS = 20;

let invalidatedKeys: unknown[][] = [];
let queryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function mount(timeoutMs: number = TEST_TIMEOUT_MS) {
  return renderHook(
    () =>
      useTurnTimeout({
        assistantId: "asst-1",
        activeConversationId: "conv-A",
        timeoutMs,
      }),
    { wrapper: Wrapper },
  );
}

function seedSnapshot(seq: number) {
  useChatSessionStore.setState({
    snapshot: {
      messages: [],
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
      seq,
    },
  });
}

beforeEach(() => {
  invalidatedKeys = [];
  queryClient = new QueryClient();
  queryClient.invalidateQueries = mock(
    async (filters?: { queryKey?: unknown[] }) => {
      invalidatedKeys.push(filters?.queryKey ?? []);
    },
  ) as unknown as QueryClient["invalidateQueries"];
  useTurnStore.setState({ ...INITIAL_TURN_STATE });
  useChatSessionStore.setState({ snapshot: null });
  useConversationStore.getState().removeProcessingConversationId("conv-A");
});

afterEach(() => {
  cleanup();
  useTurnStore.setState({ ...INITIAL_TURN_STATE });
  useChatSessionStore.setState({ snapshot: null });
  useConversationStore.getState().removeProcessingConversationId("conv-A");
});

describe("useTurnTimeout", () => {
  test("the shipped bound is minutes, not seconds", () => {
    // A turn that pauses on a slow tool call must never be cut short; the
    // watchdog exists for total silence, so the default has to be far above
    // any plausible gap between events.
    expect(TURN_SILENCE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  test("stays disarmed while the turn phase is idle", async () => {
    mount();

    await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUT_MS * 3));

    expect(useTurnStore.getState().phase).toBe("idle");
    expect(useTurnStore.getState().lastTerminalReason).toBeNull();
  });

  test("arms on turn start and terminates a silent turn", async () => {
    mount();

    act(() => {
      useTurnStore.getState().requestSend("turn-1");
    });
    expect(useTurnStore.getState().phase).toBe("thinking");

    await waitFor(() => {
      expect(useTurnStore.getState().phase).toBe("idle");
    });
    expect(useTurnStore.getState().lastTerminalReason).toBe("timeout");
    expect(useTurnStore.getState().activeTurnId).toBeNull();
  });

  test("revalidates history when it fires so the UI settles on server truth", async () => {
    mount();

    act(() => {
      useTurnStore.getState().requestSend("turn-1");
    });

    await waitFor(() => {
      expect(invalidatedKeys.length).toBeGreaterThan(0);
    });
    expect(invalidatedKeys[0]).toEqual([
      "conversation-history",
      "asst-1",
      "conv-A",
    ]);
  });

  test("clears the conversation's processing key so the reconciliation poll can run", async () => {
    // `useConversationHistory` counts `processingConversationIds` into
    // `activeInProgress`, which gates its periodic revalidation off. Leaving
    // the key set would starve the poll, so the watchdog's own one-shot
    // refetch would be the last word and a finished conversation could read
    // busy forever.
    act(() => {
      useConversationStore.getState().addProcessingConversationId("conv-A");
    });
    mount();

    act(() => {
      useTurnStore.getState().requestSend("turn-1");
    });

    await waitFor(() => {
      expect(useTurnStore.getState().phase).toBe("idle");
    });
    expect(
      useConversationStore.getState().processingConversationIds.has("conv-A"),
    ).toBe(false);
  });

  test("a terminal event before the bound disarms it", async () => {
    mount();

    act(() => {
      useTurnStore.getState().requestSend("turn-1");
    });
    act(() => {
      useTurnStore.getState().completeTurn();
    });

    await new Promise((resolve) => setTimeout(resolve, TEST_TIMEOUT_MS * 3));

    expect(useTurnStore.getState().lastTerminalReason).toBe("complete");
    expect(invalidatedKeys).toEqual([]);
  });

  test("stream activity re-arms it, so a long but live turn survives", async () => {
    seedSnapshot(1);
    mount();

    act(() => {
      useTurnStore.getState().requestSend("turn-1");
    });

    // Each folded event advances the snapshot's seq; keep advancing it for
    // longer than the bound and the turn must still be running.
    for (let seq = 2; seq <= 8; seq++) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.floor(TEST_TIMEOUT_MS / 2)),
      );
      act(() => {
        seedSnapshot(seq);
      });
    }

    expect(useTurnStore.getState().phase).toBe("thinking");
    expect(invalidatedKeys).toEqual([]);
  });
});
