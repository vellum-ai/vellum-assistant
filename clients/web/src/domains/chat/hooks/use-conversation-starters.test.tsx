/**
 * Tests for `useConversationStarters`.
 *
 * The web workspace doesn't ship `@testing-library/react`, so we follow the
 * project convention of:
 *   1. Mocking `@tanstack/react-query`'s `useQuery` to capture the options
 *      object the hook passes in.
 *   2. Driving the hook by `renderToStaticMarkup`-ing a tiny test component
 *      that calls it. The component publishes the latest hook return into
 *      a module-level holder so each test can assert on it.
 *   3. Exercising the `refetchInterval` callback captured from `useQuery`
 *      options — this is the load-bearing piece that verifies polling
 *      decisions without `vi.useFakeTimers` (which bun:test does not
 *      provide).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import * as realRQ from "@tanstack/react-query";
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  ConversationStarter,
  ConversationStartersStatus,
} from "@/domains/chat/utils/conversation-starters";
import type { ConversationstartersGetResponse } from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Captured query config + currently-served stub data.
// ---------------------------------------------------------------------------

interface CapturedQueryOptions {
  queryKey: readonly unknown[];
  queryFn: () => unknown;
  enabled: boolean;
  staleTime: number;
  refetchInterval: (query: {
    state: { data: ConversationstartersGetResponse | undefined };
  }) => number | false;
}

let lastCapturedOptions: CapturedQueryOptions | null = null;

interface UseQueryStub {
  data: ConversationstartersGetResponse | undefined;
  isLoading: boolean;
  isError?: boolean;
  fetchStatus?: "fetching" | "paused" | "idle";
  refetch: () => Promise<void>;
}

let useQueryStub: UseQueryStub = {
  data: undefined,
  isLoading: true,
  refetch: async () => {},
};

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: (options: CapturedQueryOptions) => {
    lastCapturedOptions = options;
    return useQueryStub;
  },
}));

// ---------------------------------------------------------------------------
// Subject under test (imported AFTER mocks).
// ---------------------------------------------------------------------------

import {
  useConversationStarters,
  type UseConversationStartersResult,
} from "@/domains/chat/hooks/use-conversation-starters";

// ---------------------------------------------------------------------------
// Test harness — `renderToStaticMarkup` walks function components, so this
// publishes the hook's latest return into a holder we can read after.
// ---------------------------------------------------------------------------

interface HookHarnessProps {
  assistantId: string | null | undefined;
  collect: (result: UseConversationStartersResult) => void;
}

function HookHarness({ assistantId, collect }: HookHarnessProps): null {
  const result = useConversationStarters(assistantId);
  collect(result);
  return null;
}

function runHook(
  assistantId: string | null | undefined,
): UseConversationStartersResult {
  let captured: UseConversationStartersResult | null = null;
  renderToStaticMarkup(
    <HookHarness
      assistantId={assistantId}
      collect={(result) => {
        captured = result;
      }}
    />,
  );
  if (!captured) {
    throw new Error("HookHarness did not invoke the hook");
  }
  return captured;
}

beforeEach(() => {
  lastCapturedOptions = null;
  useQueryStub = {
    data: undefined,
    isLoading: true,
    refetch: async () => {},
  };
});

// ---------------------------------------------------------------------------
// Idle behavior
// ---------------------------------------------------------------------------

describe("useConversationStarters — idle state", () => {
  test("returns idle when assistantId is null", () => {
    const result = runHook(null);

    expect(result.status).toBe("idle");
    expect(result.starters).toEqual([]);
    expect(result.isLoading).toBe(false);
  });

  test("returns idle when assistantId is undefined", () => {
    const result = runHook(undefined);
    expect(result.status).toBe("idle");
    expect(result.starters).toEqual([]);
    expect(result.isLoading).toBe(false);
  });

  test("returns idle when assistantId is the empty string", () => {
    const result = runHook("");
    expect(result.status).toBe("idle");
  });

  test("idle refetch resolves and does NOT trigger a query", async () => {
    const result = runHook(null);
    await result.refetch();
    expect(lastCapturedOptions?.enabled).toBe(false);
  });

  test("disables the query when no assistantId is given", () => {
    runHook(null);
    expect(lastCapturedOptions).not.toBeNull();
    expect(lastCapturedOptions!.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useQuery wiring
// ---------------------------------------------------------------------------

describe("useConversationStarters — query wiring", () => {
  test("query key uses the generated object-based format", () => {
    runHook("asst-1");
    expect(lastCapturedOptions).not.toBeNull();

    const key = lastCapturedOptions!.queryKey;
    expect(key).toHaveLength(1);
    const keyObj = key[0] as Record<string, unknown>;
    expect(keyObj._id).toBe("conversationstartersGet");
    expect(keyObj.path).toEqual({ assistant_id: "asst-1" });
    expect(keyObj.query).toEqual({
      limit: 4,
      offset: 0,
    });
  });

  test("enables the query when an assistantId is supplied", () => {
    runHook("asst-1");
    expect(lastCapturedOptions!.enabled).toBe(true);
  });

  test("staleTime is 60s so re-mounts within a minute don't re-fetch", () => {
    runHook("asst-1");
    expect(lastCapturedOptions!.staleTime).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Polling decision (`refetchInterval`)
// ---------------------------------------------------------------------------

describe("useConversationStarters — polling decision", () => {
  test("refetchInterval polls at 3s while generating, stops when ready", () => {
    runHook("asst-1");
    const ri = lastCapturedOptions!.refetchInterval;

    expect(
      ri({ state: { data: { starters: [], total: 0, status: "generating" } } }),
    ).toBe(3000);
    expect(
      ri({ state: { data: { starters: [], total: 0, status: "refreshing" } } }),
    ).toBe(3000);
    expect(
      ri({ state: { data: { starters: [], total: 0, status: "ready" } } }),
    ).toBe(false);
    expect(
      ri({ state: { data: { starters: [], total: 0, status: "empty" } } }),
    ).toBe(false);
    expect(ri({ state: { data: undefined } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Result projection
// ---------------------------------------------------------------------------

describe("useConversationStarters — projects query state to result", () => {
  test("resolves to ready with the daemon's starters", () => {
    const starters: ConversationStarter[] = [
      {
        id: "s1",
        label: "Plan a trip",
        prompt: "Help me plan a trip",
        category: "travel",
        batch: 0,
      },
      {
        id: "s2",
        label: "Brainstorm",
        prompt: "Brainstorm 10 ideas",
        category: null,
        batch: 1,
      },
      {
        id: "s3",
        label: "Summarize",
        prompt: "Summarize the news",
        category: "news",
        batch: 1,
      },
    ];
    useQueryStub = {
      data: { starters, total: 3, status: "ready" },
      isLoading: false,
      refetch: async () => {},
    };

    const result = runHook("asst-1");

    expect(result.status).toBe("ready");
    expect(result.starters).toHaveLength(3);
    expect(result.starters[0]!.label).toBe("Plan a trip");
    expect(result.isLoading).toBe(false);
  });

  test("exposes loading state while the first fetch is in flight", () => {
    useQueryStub = {
      data: undefined,
      isLoading: true,
      refetch: async () => {},
    };

    const result = runHook("asst-1");

    expect(result.isLoading).toBe(true);
    expect(result.starters).toEqual([]);
  });

  test("forwards a 'generating' status from the daemon", () => {
    const generatingStatus: ConversationStartersStatus = "generating";
    useQueryStub = {
      data: { starters: [], total: 0, status: generatingStatus },
      isLoading: false,
      refetch: async () => {},
    };

    const result = runHook("asst-1");

    expect(result.status).toBe("generating");
  });

  test("refetch delegates to the underlying query's refetch", async () => {
    let refetchCalls = 0;
    useQueryStub = {
      data: { starters: [], total: 0, status: "ready" },
      isLoading: false,
      refetch: async () => {
        refetchCalls += 1;
      },
    };

    const result = runHook("asst-1");
    await result.refetch();

    expect(refetchCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Awaiting flag: drives the empty state's reserved starters dock
// ---------------------------------------------------------------------------

describe("useConversationStarters isAwaitingStarters", () => {
  test("waits while the first fetch is in flight", () => {
    useQueryStub = {
      data: undefined,
      isLoading: true,
      refetch: async () => {},
    };

    expect(runHook("asst-1").isAwaitingStarters).toBe(true);
  });

  test("waits while the daemon reports it is still generating", () => {
    useQueryStub = {
      data: { starters: [], total: 0, status: "generating" },
      isLoading: false,
      refetch: async () => {},
    };

    expect(runHook("asst-1").isAwaitingStarters).toBe(true);
  });

  test("waits through a refresh that has nothing to show yet", () => {
    useQueryStub = {
      data: { starters: [], total: 0, status: "refreshing" },
      isLoading: false,
      refetch: async () => {},
    };

    expect(runHook("asst-1").isAwaitingStarters).toBe(true);
  });

  test("stops waiting once starters arrive, even mid-refresh", () => {
    useQueryStub = {
      data: {
        starters: [
          {
            id: "s1",
            label: "Plan a trip",
            prompt: "Help me plan a trip",
            category: null,
            batch: 0,
          },
        ],
        total: 1,
        status: "refreshing",
      },
      isLoading: false,
      refetch: async () => {},
    };

    expect(runHook("asst-1").isAwaitingStarters).toBe(false);
  });

  test("stops waiting when the daemon settles on having none", () => {
    useQueryStub = {
      data: { starters: [], total: 0, status: "ready" },
      isLoading: false,
      refetch: async () => {},
    };

    expect(runHook("asst-1").isAwaitingStarters).toBe(false);
  });

  test("stops waiting on a failed fetch, which reports no status of its own", () => {
    // A failed query leaves `data` undefined, so the status falls back to
    // "generating". Without the error check the dock would hold space for
    // chips that are never coming.
    useQueryStub = {
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: async () => {},
    };

    expect(runHook("asst-1").isAwaitingStarters).toBe(false);
  });

  test("an idle query never waits", () => {
    expect(runHook(null).isAwaitingStarters).toBe(false);
  });

  test("stops waiting on a fetch the browser paused for being offline", () => {
    // TanStack's default `networkMode` holds the request while offline: no
    // load is reported and no error arrives, so `data` stays undefined and
    // the status keeps falling back to "generating". Nothing else here would
    // ever end that wait.
    useQueryStub = {
      data: undefined,
      isLoading: false,
      fetchStatus: "paused",
      refetch: async () => {},
    };

    expect(runHook("asst-1").isAwaitingStarters).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Awaiting deadline: a generation that never lands must not pin the reserve
// ---------------------------------------------------------------------------

describe("useConversationStarters await deadline", () => {
  afterEach(() => {
    cleanup();
  });

  test("stops waiting once the deadline passes on a generation that never lands", async () => {
    // The daemon can keep answering "generating" indefinitely. Without a
    // deadline the empty state's reserved dock holds its space for the life
    // of the screen.
    useQueryStub = {
      data: { starters: [], total: 0, status: "generating" },
      isLoading: false,
      refetch: async () => {},
    };

    const { result } = renderHook(() =>
      useConversationStarters("asst-1", { awaitDeadlineMs: 10 }),
    );
    expect(result.current.isAwaitingStarters).toBe(true);

    await waitFor(() => {
      expect(result.current.isAwaitingStarters).toBe(false);
    });
  });

  test("the deadline restarts for a different assistant", async () => {
    useQueryStub = {
      data: { starters: [], total: 0, status: "generating" },
      isLoading: false,
      refetch: async () => {},
    };

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) =>
        useConversationStarters(id, { awaitDeadlineMs: 30 }),
      { initialProps: { id: "asst-1" } },
    );
    await waitFor(() => {
      expect(result.current.isAwaitingStarters).toBe(false);
    });

    rerender({ id: "asst-2" });
    expect(result.current.isAwaitingStarters).toBe(true);
  });

  test("a switch away from an expired assistant never commits an expired frame", async () => {
    // `rerender` flushes effects before returning, so asserting on the final
    // value cannot see a stale frame. The probe records every COMMITTED frame
    // instead: a post-commit reset paints one expired frame first, which
    // collapses the reserved dock and re-expands it mid-transition.
    useQueryStub = {
      data: { starters: [], total: 0, status: "generating" },
      isLoading: false,
      refetch: async () => {},
    };

    const committed: boolean[] = [];
    function Probe({ id }: { id: string }) {
      const { isAwaitingStarters } = useConversationStarters(id, {
        awaitDeadlineMs: 10,
      });
      useEffect(() => {
        committed.push(isAwaitingStarters);
      });
      return null;
    }

    const { rerender } = render(<Probe id="asst-1" />);
    await waitFor(() => {
      expect(committed.at(-1)).toBe(false);
    });

    committed.length = 0;
    rerender(<Probe id="asst-2" />);

    expect(committed.length).toBeGreaterThan(0);
    expect(committed.every((frame) => frame === true)).toBe(true);
  });

  test("re-enabling the same assistant restarts the deadline", async () => {
    useQueryStub = {
      data: { starters: [], total: 0, status: "generating" },
      isLoading: false,
      refetch: async () => {},
    };

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) =>
        useConversationStarters(id, { awaitDeadlineMs: 10 }),
      { initialProps: { id: "asst-1" as string | null } },
    );
    await waitFor(() => {
      expect(result.current.isAwaitingStarters).toBe(false);
    });

    rerender({ id: null });
    rerender({ id: "asst-1" });
    expect(result.current.isAwaitingStarters).toBe(true);
  });
});
