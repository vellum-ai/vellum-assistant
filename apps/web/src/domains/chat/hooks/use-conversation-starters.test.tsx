/**
 * Tests for `useConversationStarters`.
 *
 * The web workspace doesn't ship `@testing-library/react`, so we follow the
 * project convention of:
 *   1. Mocking `@tanstack/react-query`'s `useQuery` to capture the options
 *      object the hook passes in.
 *   2. Stubbing the daemon client (`./conversation-starters`) so we can
 *      shape the response without hitting the network.
 *   3. Driving the hook by `renderToStaticMarkup`-ing a tiny test component
 *      that calls it. The component publishes the latest hook return into
 *      a module-level holder so each test can assert on it.
 *   4. Exercising the `refetchInterval` callback captured from `useQuery`
 *      options — this is the load-bearing piece that verifies polling
 *      decisions without `vi.useFakeTimers` (which bun:test does not
 *      provide).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  ConversationStarter,
  ConversationStartersStatus,
  ListConversationStartersResult,
} from "@/domains/chat/utils/conversation-starters";

// ---------------------------------------------------------------------------
// Captured query config + currently-served stub data.
// ---------------------------------------------------------------------------

interface CapturedQueryOptions {
  queryKey: readonly unknown[];
  queryFn: () => unknown;
  enabled: boolean;
  staleTime: number;
  refetchInterval: (query: {
    state: { data: ListConversationStartersResult | undefined };
  }) => number | false;
}

let lastCapturedOptions: CapturedQueryOptions | null = null;

interface UseQueryStub {
  data: ListConversationStartersResult | undefined;
  isLoading: boolean;
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
// Daemon client mock — captures calls + returns whatever the test seeds.
// ---------------------------------------------------------------------------

interface DaemonCall {
  assistantId: string;
  opts: { limit?: number; offset?: number; scopeId?: string } | undefined;
}

const daemonCalls: DaemonCall[] = [];
let daemonResponse: ListConversationStartersResult = {
  starters: [],
  total: 0,
  status: "ready",
};

mock.module("@/domains/chat/utils/conversation-starters", () => ({
  listConversationStarters: (
    assistantId: string,
    opts?: { limit?: number; offset?: number; scopeId?: string },
  ) => {
    daemonCalls.push({ assistantId, opts });
    return Promise.resolve(daemonResponse);
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
  // Publishing the hook result through a callback prop is the standard
  // bun:test workaround for not having `@testing-library/react`'s
  // `renderHook`. We're inside `renderToStaticMarkup`, so this fires
  // exactly once per `runHook` call.
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
  daemonCalls.length = 0;
  daemonResponse = { starters: [], total: 0, status: "ready" };
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

  test("idle refetch resolves and does NOT call the daemon", async () => {
    const result = runHook(null);
    await result.refetch();
    expect(daemonCalls).toHaveLength(0);
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
  test("query key is namespaced and includes the assistant id", () => {
    runHook("asst-1");
    expect(lastCapturedOptions).not.toBeNull();
    expect(lastCapturedOptions!.queryKey).toEqual([
      "conversation-starters",
      "asst-1",
    ]);
  });

  test("enables the query when an assistantId is supplied", () => {
    runHook("asst-1");
    expect(lastCapturedOptions!.enabled).toBe(true);
  });

  test("staleTime is 60s so re-mounts within a minute don't re-fetch", () => {
    runHook("asst-1");
    expect(lastCapturedOptions!.staleTime).toBe(60_000);
  });

  test("queryFn calls the daemon with the chip-cap limit", async () => {
    runHook("asst-1");
    await lastCapturedOptions!.queryFn();

    expect(daemonCalls).toHaveLength(1);
    expect(daemonCalls[0]!.assistantId).toBe("asst-1");
    expect(daemonCalls[0]!.opts).toEqual({ limit: 4 });
  });
});

// ---------------------------------------------------------------------------
// Polling decision (`refetchInterval`)
// ---------------------------------------------------------------------------

describe("useConversationStarters — polling decision", () => {
  test("refetchInterval polls at 3s while generating, stops when ready", () => {
    runHook("asst-1");
    const ri = lastCapturedOptions!.refetchInterval;

    expect(ri({ state: { data: { starters: [], total: 0, status: "generating" } } })).toBe(3000);
    expect(ri({ state: { data: { starters: [], total: 0, status: "refreshing" } } })).toBe(3000);
    expect(ri({ state: { data: { starters: [], total: 0, status: "ready" } } })).toBe(false);
    expect(ri({ state: { data: { starters: [], total: 0, status: "empty" } } })).toBe(false);
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
