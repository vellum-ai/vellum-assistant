/**
 * Tests for `useRefreshLatestMessages` — the non-destructive refresh
 * handler wired to the chat title chevron's Refresh menu item.
 *
 * The bug this hook fixes: the previous menu Refresh path called
 * `handleRefreshConversation`, which evicted the conversation cache and
 * bumped `refreshEpoch`, triggering a full conversation-load effect that
 * called `setMessages([])`, tore down the SSE stream, and reset pagination.
 * For a 50-message conversation mid-stream this wiped the partial assistant
 * bubble, closed the live stream, and lost any paged-in older history.
 *
 * The new hook fetches the latest history page and merges it via
 * `reconcileDisplayMessagesWithLatestHistory`. The tests below verify the
 * non-destructive contract:
 *   - never calls `setMessages([])`
 *   - preserves streaming bubbles that the latest history page doesn't
 *     include yet
 *   - preserves optimistic user rows; upgrades them when matched
 *   - drops the result if the user switched conversations mid-fetch
 *     (no cross-thread bleed)
 *   - reports `{ kind: "error" }` on fetch failure without touching state
 *   - reports `{ kind: "no-change" }` when the latest page matches current
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

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";

import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";

// ---------------------------------------------------------------------------
// Mocked daemon clients. `mock.module` is process-global in bun:test, so we
// stub the two functions the hook fans out to:
//   - `fetchLatestHistoryPage` (`@/domains/chat/api/history`)
//   - `fetchSurfaceContent`    (`@/domains/chat/api/surfaces`)
// Tests seed the next response on the corresponding holder.
// ---------------------------------------------------------------------------

interface FetchLatestCall {
  assistantId: string;
  conversationId: string;
}

const fetchLatestCalls: FetchLatestCall[] = [];
let fetchLatestImpl: (
  assistantId: string,
  conversationId: string,
) => Promise<PaginatedHistoryResult> = async () => ({
  messages: [],
  hasMore: false,
  oldestTimestamp: null,
  oldestMessageId: null,
});

mock.module("@/domains/chat/api/history", () => ({
  fetchLatestHistoryPage: (assistantId: string, conversationId: string) => {
    fetchLatestCalls.push({ assistantId, conversationId });
    return fetchLatestImpl(assistantId, conversationId);
  },
}));

const fetchSurfaceCalls: Array<{
  assistantId: string;
  surfaceId: string;
  conversationId: string;
}> = [];
let fetchSurfaceImpl: (
  assistantId: string,
  surfaceId: string,
  conversationId: string,
) => Promise<{
  surfaceId: string;
  surfaceType: string;
  title?: string | null;
  data: Record<string, unknown>;
} | null> = async () => null;

mock.module("@/domains/chat/api/surfaces", () => ({
  fetchSurfaceContent: (
    assistantId: string,
    surfaceId: string,
    conversationId: string,
  ) => {
    fetchSurfaceCalls.push({ assistantId, surfaceId, conversationId });
    return fetchSurfaceImpl(assistantId, surfaceId, conversationId);
  },
}));

// Subject under test — imported AFTER mocks are registered.
import {
  classifyRefreshLatestOutcome,
  type RefreshLatestOutcome,
  useRefreshLatestMessages,
} from "@/domains/chat/hooks/use-refresh-latest-messages";
import { liveAssistantRowId } from "@/domains/chat/utils/stream-updaters/shared";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  __resetServerSeqForTesting,
  getServerSeq,
} from "@/lib/streaming/server-seq";

import { messageText, textBody } from "@/domains/chat/utils/message-test-helpers";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(
  overrides: Omit<DisplayMessage, "id"> & { id?: string },
): DisplayMessage {
  const { id, ...rest } = overrides;
  return {
    id: id ?? crypto.randomUUID(),
    ...rest,
  };
}

interface HostState {
  messages: DisplayMessage[];
  setMessagesCalls: Array<DisplayMessage[]>;
}

function makeHost(
  initial: DisplayMessage[],
  conversationId: string | null,
  dismissed: Set<string> = new Set(),
): HostState {
  useConversationStore.setState({
    activeConversationId: conversationId,
    processingConversationIds: new Set(),
  });
  const host: HostState = {
    messages: initial,
    setMessagesCalls: [],
  };
  // Seed the chat session store with the initial state
  useChatSessionStore.setState({
    messages: initial,
    dismissedSurfaceIds: dismissed,
    setMessages: ((update: DisplayMessage[] | ((prev: DisplayMessage[]) => DisplayMessage[])) => {
      const prev = useChatSessionStore.getState().messages;
      const next =
        typeof update === "function"
          ? (update as (prev: DisplayMessage[]) => DisplayMessage[])(prev)
          : update;
      host.setMessagesCalls.push(next);
      host.messages = next;
      useChatSessionStore.setState({ messages: next });
    }) as never,
  });
  return host;
}

// ---------------------------------------------------------------------------
// Test lifecycle — reset module-level holders between cases so each test
// starts from a clean state regardless of run order.
// ---------------------------------------------------------------------------

beforeEach(() => {
  fetchLatestCalls.length = 0;
  fetchSurfaceCalls.length = 0;
  fetchLatestImpl = async () => ({
    messages: [],
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
  });
  fetchSurfaceImpl = async () => null;
  __resetServerSeqForTesting();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useRefreshLatestMessages", () => {
  test("returns no-change without fetching when there is no active conversation", async () => {
    const host = makeHost([], null);
    const { result } = renderHook(() =>
      useRefreshLatestMessages({
        assistantId: "asst-1",
      }),
    );

    let outcome: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      outcome = await result.current();
    });

    expect(outcome).toEqual({ kind: "no-change" });
    expect(fetchLatestCalls).toHaveLength(0);
    expect(host.setMessagesCalls).toHaveLength(0);
  });

  test("returns no-change without fetching when assistantId is null", async () => {
    const host = makeHost([], "conv-1");
    const { result } = renderHook(() =>
      useRefreshLatestMessages({
        assistantId: null,
      }),
    );

    let outcome: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      outcome = await result.current();
    });

    expect(outcome).toEqual({ kind: "no-change" });
    expect(fetchLatestCalls).toHaveLength(0);
    expect(host.setMessagesCalls).toHaveLength(0);
  });

  test("appends newly-arrived messages and reports new-messages count", async () => {
    const existingUser = makeMsg({
      id: "u1",
      role: "user",
      ...textBody("Hello"),
      timestamp: 1000,
    });
    const existingAssistant = makeMsg({
      id: "a1",
      role: "assistant",
      ...textBody("Hi."),
      timestamp: 1010,
    });
    const newUser = makeMsg({
      id: "u2",
      role: "user",
      ...textBody("Anything new?"),
      timestamp: 1020,
    });
    const newAssistant = makeMsg({
      id: "a2",
      role: "assistant",
      ...textBody("Yes, here's the update."),
      timestamp: 1030,
    });

    const host = makeHost([existingUser, existingAssistant], "conv-1");
    fetchLatestImpl = async () => ({
      messages: [existingUser, existingAssistant, newUser, newAssistant],
      hasMore: true,
      oldestTimestamp: 1000,
      oldestMessageId: "u1",
      seq: 17,
    });

    const { result } = renderHook(() =>
      useRefreshLatestMessages({
        assistantId: "asst-1",
      }),
    );

    let outcome: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      outcome = await result.current();
    });

    expect(outcome).toEqual({ kind: "new-messages", count: 2 });
    expect(fetchLatestCalls).toEqual([
      { assistantId: "asst-1", conversationId: "conv-1" },
    ]);
    // CRITICAL: setMessages must be called with a merge, NEVER with [].
    // This is the load-bearing contract change for the menu Refresh bug.
    expect(host.setMessagesCalls).toHaveLength(1);
    expect(host.setMessagesCalls[0]).not.toEqual([]);
    expect(host.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
    // The accepted snapshot's seq is recorded as the conversation baseline.
    expect(getServerSeq("conv-1")).toBe(17);
  });

  test("preserves an in-flight streaming assistant bubble that latest history does not include", async () => {
    const completedUser = makeMsg({
      id: "u1",
      role: "user",
      ...textBody("Tell me a story"),
      timestamp: 1000,
    });
    // Streaming assistant — no server id yet. The latest history page below
    // intentionally omits this row to simulate a refresh that fires while
    // the stream hasn't completed server-side.
    const streamingAssistant = makeMsg({
      id: "a-streaming",
      role: "assistant",
      ...textBody("Once upon a time, there was a"),
      timestamp: 1010,
    });

    const host = makeHost(
      [completedUser, streamingAssistant],
      "conv-1",
    );
    // The row's liveness is derived from the conversation processing state,
    // not a stored flag — mark the conversation processing so the merge
    // treats the trailing assistant as the live row.
    useConversationStore.getState().markConversationProcessing("conv-1");
    fetchLatestImpl = async () => ({
      messages: [completedUser],
      hasMore: false,
      oldestTimestamp: 1000,
      oldestMessageId: "u1",
    });

    const { result } = renderHook(() =>
      useRefreshLatestMessages({
        assistantId: "asst-1",
      }),
    );

    await act(async () => {
      await result.current();
    });

    // The streaming bubble must survive the merge — losing it is exactly
    // what the previous destructive refresh did.
    const ids = host.messages.map((m) => m.id);
    expect(ids).toContain("a-streaming");
    const survivor = host.messages.find((m) => m.id === "a-streaming");
    expect(liveAssistantRowId(host.messages, true)).toBe("a-streaming");
    expect(messageText(survivor)).toBe("Once upon a time, there was a");
  });

  test("upgrades an optimistic user row with the matching server id when latest history confirms it", async () => {
    const optimisticUser = makeMsg({
      id: "u-optimistic",
      role: "user",
      ...textBody("Plan a Stockholm trip"),
      timestamp: 1000,
      isOptimistic: true,
    });
    const confirmedUser = makeMsg({
      id: "u-server-1",
      role: "user",
      ...textBody("Plan a Stockholm trip"),
      timestamp: 1000,
    });

    const host = makeHost([optimisticUser], "conv-1");
    fetchLatestImpl = async () => ({
      messages: [confirmedUser],
      hasMore: false,
      oldestTimestamp: 1000,
      oldestMessageId: "u-server-1",
    });

    const { result } = renderHook(() =>
      useRefreshLatestMessages({
        assistantId: "asst-1",
      }),
    );

    await act(async () => {
      await result.current();
    });

    // The optimistic row picks up the server id.
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]).toMatchObject({
      id: "u-server-1",
      role: "user",
      ...textBody("Plan a Stockholm trip"),
    });
  });

  test("drops the result silently when the user switches conversations mid-fetch (no cross-thread bleed)", async () => {
    const conv1Msg = makeMsg({
      id: "u1",
      role: "user",
      ...textBody("Message in conversation 1"),
      timestamp: 1000,
    });
    const conv2Msg = makeMsg({
      id: "u2",
      role: "user",
      ...textBody("Message in conversation 2"),
      timestamp: 2000,
    });

    // Host starts on conv-1 with conv1Msg loaded.
    const host = makeHost([conv1Msg], "conv-1");

    // Simulate the user switching to conv-2 between the fetch dispatch
    // and the fetch resolving. Inside the fetch impl, we mutate the
    // conversation store directly — this races the post-fetch staleness
    // check the hook performs.
    fetchLatestImpl = async () => {
      useConversationStore.setState({ activeConversationId: "conv-2" });
      host.messages = [conv2Msg];
      useChatSessionStore.setState({ messages: [conv2Msg] });
      // Return a "latest" page for the original conversation. If the
      // staleness check fails, these messages would land in conv-2's
      // transcript — that's the bug class the guard prevents.
      return {
        messages: [
          conv1Msg,
          makeMsg({
            id: "a-new",
            role: "assistant",
            ...textBody("This belongs to conversation 1"),
            timestamp: 1500,
          }),
        ],
        hasMore: false,
        oldestTimestamp: 1000,
        oldestMessageId: "u1",
        seq: 50,
      };
    };

    const { result } = renderHook(() =>
      useRefreshLatestMessages({
        assistantId: "asst-1",
      }),
    );

    let outcome: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      outcome = await result.current();
    });

    expect(outcome).toEqual({ kind: "no-change" });
    // setMessages must NOT have been called — the stale result was dropped.
    expect(host.setMessagesCalls).toHaveLength(0);
    // conv-2's transcript stays clean: no conv-1 messages bled in.
    expect(host.messages).toEqual([conv2Msg]);
    // The dropped result must NOT record a baseline for conv-1: recording is
    // gated behind the same stale-response check that dropped the messages.
    expect(getServerSeq("conv-1")).toBeNull();
  });

  test("returns error outcome without touching state when the fetch rejects", async () => {
    const existing = makeMsg({
      id: "u1",
      role: "user",
      ...textBody("Hi"),
      timestamp: 1000,
    });
    const host = makeHost([existing], "conv-1");
    const fetchError = new Error("daemon unreachable");
    fetchLatestImpl = async () => {
      throw fetchError;
    };

    const { result } = renderHook(() =>
      useRefreshLatestMessages({
        assistantId: "asst-1",
      }),
    );

    let outcome: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      outcome = await result.current();
    });

    expect(outcome).toEqual({ kind: "error", error: fetchError });
    expect(host.setMessagesCalls).toHaveLength(0);
    expect(host.messages).toEqual([existing]);
  });

  test("reports no-change and produces a reference-equal next array when the latest page matches current", async () => {
    const user = makeMsg({
      id: "u1",
      role: "user",
      ...textBody("Hello"),
      timestamp: 1000,
    });
    const assistant = makeMsg({
      id: "a1",
      role: "assistant",
      ...textBody("Hi."),
      timestamp: 1010,
    });
    const host = makeHost([user, assistant], "conv-1");
    fetchLatestImpl = async () => ({
      messages: [user, assistant],
      hasMore: false,
      oldestTimestamp: 1000,
      oldestMessageId: "u1",
    });

    const { result } = renderHook(() =>
      useRefreshLatestMessages({
        assistantId: "asst-1",
      }),
    );

    let outcome: Awaited<ReturnType<typeof result.current>> | undefined;
    await act(async () => {
      outcome = await result.current();
    });

    expect(outcome).toEqual({ kind: "no-change" });
    // setMessages was invoked, but the updater returned the same array
    // reference so React skips the re-render. The contract callers care
    // about is that the rendered messages haven't changed.
    expect(host.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  test("strips locally-dismissed surfaces from the merged page so they don't reappear", async () => {
    // User has dismissed surface "s-confirm" — once gone, a refresh must
    // NOT resurrect it, or the composer gets re-wedged by a stale prompt.
    const dismissed = new Set(["s-confirm"]);
    const host = makeHost([], "conv-1", dismissed);
    fetchLatestImpl = async () => ({
      messages: [
        makeMsg({
          id: "a1",
          role: "assistant",
          ...textBody("Please confirm"),
          timestamp: 1000,
          surfaces: [
            {
              surfaceId: "s-confirm",
              surfaceType: "confirmation",
              data: {},
            },
            {
              surfaceId: "s-keep",
              surfaceType: "info",
              data: {},
            },
          ],
          contentOrder: [
            { type: "text", id: "t1" },
            { type: "surface", id: "s-confirm" },
            { type: "surface", id: "s-keep" },
          ],
        }),
      ],
      hasMore: false,
      oldestTimestamp: 1000,
      oldestMessageId: "a1",
    });

    const { result } = renderHook(() =>
      useRefreshLatestMessages({
        assistantId: "asst-1",
      }),
    );

    await act(async () => {
      await result.current();
    });

    const merged = host.messages[0]!;
    expect(merged.surfaces?.map((s) => s.surfaceId)).toEqual(["s-keep"]);
    expect(merged.contentOrder).toEqual([
      { type: "text", id: "t1" },
      { type: "surface", id: "s-keep" },
    ]);
    // Surface refresh loop must skip dismissed IDs too — otherwise we'd
    // fetch content for a surface we just filtered out.
    expect(
      fetchSurfaceCalls.map((c) => c.surfaceId),
    ).not.toContain("s-confirm");
    expect(fetchSurfaceCalls.map((c) => c.surfaceId)).toEqual(["s-keep"]);
  });

  test("supersedes a stale concurrent refresh: only the latest invocation can commit updates", async () => {
    // Two rapid Refresh clicks on the same conversation. Refresh A starts,
    // then Refresh B starts; B resolves first with fresh data, A resolves
    // later with what is now stale data. A must NOT clobber B.
    const existing = makeMsg({
      id: "u1",
      role: "user",
      ...textBody("Hello"),
      timestamp: 1000,
    });
    const fresherMsg = makeMsg({
      id: "a-fresh",
      role: "assistant",
      ...textBody("Fresh response from refresh B"),
      timestamp: 1020,
    });
    const stalerMsg = makeMsg({
      id: "a-stale",
      role: "assistant",
      ...textBody("Stale response from refresh A"),
      timestamp: 1010,
    });

    const host = makeHost([existing], "conv-1");

    // Deferred promises so the test controls resolution order.
    let resolveA!: (page: PaginatedHistoryResult) => void;
    let resolveB!: (page: PaginatedHistoryResult) => void;
    const pendingA = new Promise<PaginatedHistoryResult>((r) => {
      resolveA = r;
    });
    const pendingB = new Promise<PaginatedHistoryResult>((r) => {
      resolveB = r;
    });
    let callIdx = 0;
    fetchLatestImpl = () => {
      const idx = callIdx++;
      return idx === 0 ? pendingA : pendingB;
    };

    const { result } = renderHook(() =>
      useRefreshLatestMessages({
        assistantId: "asst-1",
      }),
    );

    // Dispatch A and B in quick succession.
    let outcomeA: RefreshLatestOutcome | undefined;
    let outcomeB: RefreshLatestOutcome | undefined;
    await act(async () => {
      const promiseA = result.current().then((o) => {
        outcomeA = o;
      });
      const promiseB = result.current().then((o) => {
        outcomeB = o;
      });

      // B resolves first with the fresh page (higher seq).
      resolveB({
        messages: [existing, fresherMsg],
        hasMore: false,
        oldestTimestamp: 1000,
        oldestMessageId: "u1",
        seq: 20,
      });
      // Then A resolves with the (now-stale) page (lower seq).
      resolveA({
        messages: [existing, stalerMsg],
        hasMore: false,
        oldestTimestamp: 1000,
        oldestMessageId: "u1",
        seq: 10,
      });

      await Promise.all([promiseA, promiseB]);
    });

    // B committed; A was dropped silently.
    expect(host.messages.map((m) => m.id)).toEqual(["u1", "a-fresh"]);
    expect(host.setMessagesCalls).toHaveLength(1);
    expect(outcomeB).toEqual({ kind: "new-messages", count: 1 });
    expect(outcomeA).toEqual({ kind: "no-change" });
    // The baseline reflects B's seq, not A's: recording happens after the
    // stale-response guard, so the slower out-of-order A can't regress it.
    expect(getServerSeq("conv-1")).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Pure helper — classifyRefreshLatestOutcome
// ---------------------------------------------------------------------------

describe("classifyRefreshLatestOutcome", () => {
  test("identity-equal arrays produce no-change", () => {
    const arr: DisplayMessage[] = [];
    expect(classifyRefreshLatestOutcome(arr, arr)).toEqual({
      kind: "no-change",
    });
  });

  test("longer next array produces new-messages with the length delta", () => {
    const current: DisplayMessage[] = [
      makeMsg({
        id: "u1",
        role: "user",
        ...textBody("Hi"),
        timestamp: 1000,
      }),
    ];
    const next: DisplayMessage[] = [
      ...current,
      makeMsg({
        id: "a1",
        role: "assistant",
        ...textBody("Hello"),
        timestamp: 1010,
      }),
      makeMsg({
        id: "u2",
        role: "user",
        ...textBody("How are you?"),
        timestamp: 1020,
      }),
    ];
    expect(classifyRefreshLatestOutcome(current, next)).toEqual({
      kind: "new-messages",
      count: 2,
    });
  });

  test("same-length-but-different-reference arrays produce merged (in-place mutation)", () => {
    const current: DisplayMessage[] = [
      makeMsg({
        id: "a1",
        role: "assistant",
        ...textBody("Streaming..."),
        timestamp: 1000,
      }),
    ];
    const next: DisplayMessage[] = [
      makeMsg({
        id: "a1",
        role: "assistant",
        ...textBody("Streaming finalized"),
        timestamp: 1000,
      }),
    ];
    expect(classifyRefreshLatestOutcome(current, next)).toEqual({
      kind: "merged",
    });
  });
});
