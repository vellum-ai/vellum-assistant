/**
 * Tests for `useLiveThinkingText` — the selector that re-derives a thinking
 * drawer's reasoning text from the rendered transcript (the materialized
 * snapshot ⊕ optimistic sends) so an open drawer streams while the assistant
 * thinks and stays whole after the turn commits, instead of freezing its
 * open-time snapshot.
 *
 * The chat-session store transitively pulls in the generated daemon SDK. Stub
 * every endpoint it exports so the module loads; nothing here invokes them.
 * Mirrors the comprehensive mock in `multi-activity-group.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
const sdkMock = Object.fromEntries(exportNames.map((n) => [n, sdkStub]));
mock.module("@/generated/daemon/sdk.gen", () => sdkMock);

const { useLiveThinkingText } = await import(
  "@/domains/chat/hooks/use-live-thinking-text"
);
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);
import type { DisplayMessage } from "@/domains/chat/types/types";

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const render = <T,>(hook: () => T) => renderHook(hook, { wrapper });

/** Seed the materialized snapshot — the single source the transcript renders. */
function seed(messages: DisplayMessage[]) {
  act(() => {
    useChatSessionStore.setState({
      snapshot: {
        messages,
        seq: null,
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
      },
    });
  });
}

/**
 * Seed committed history. History now folds into the materialized snapshot
 * (the transcript's single render source), so this writes the same snapshot
 * as `seed`; when both are used, the later write wins.
 */
function seedHistory(messages: DisplayMessage[]) {
  seed(messages);
}

function msg(overrides: Partial<DisplayMessage>): DisplayMessage {
  return { id: "m1", role: "assistant", ...overrides } as DisplayMessage;
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
  });
  queryClient.clear();
});

describe("useLiveThinkingText", () => {
  test("returns null without a message id or group index", () => {
    seed([msg({ contentBlocks: [{ type: "thinking", thinking: "a" }] })]);
    expect(render(() => useLiveThinkingText(undefined, 0)).result.current).toBeNull();
    expect(render(() => useLiveThinkingText("m1", undefined)).result.current).toBeNull();
  });

  test("returns null when the message is absent", () => {
    seed([]);
    const { result } = render(() => useLiveThinkingText("missing", 0));
    expect(result.current).toBeNull();
  });

  test("returns the group's combined thinking when no item index is given", () => {
    // A `thinking → tool → thinking` run groups into ONE activity group whose
    // two reasoning segments are newline-joined for the combined panel.
    seed([
      msg({
        contentBlocks: [
          { type: "thinking", thinking: "first" },
          { type: "tool_use", toolCall: { id: "t1", name: "bash", input: {} } },
          { type: "thinking", thinking: "second" },
        ],
      }),
    ]);
    const { result } = render(() => useLiveThinkingText("m1", 0));
    expect(result.current).toBe("first\nsecond");
  });

  test("selects a single reasoning segment by item index", () => {
    seed([
      msg({
        contentBlocks: [
          { type: "thinking", thinking: "first" },
          { type: "tool_use", toolCall: { id: "t1", name: "bash", input: {} } },
          { type: "thinking", thinking: "second" },
        ],
      }),
    ]);
    expect(render(() => useLiveThinkingText("m1", 0, 0)).result.current).toBe(
      "first",
    );
    expect(render(() => useLiveThinkingText("m1", 0, 1)).result.current).toBe(
      "second",
    );
  });

  test("returns null for an out-of-range item index", () => {
    seed([msg({ contentBlocks: [{ type: "thinking", thinking: "only" }] })]);
    const { result } = render(() => useLiveThinkingText("m1", 0, 5));
    expect(result.current).toBeNull();
  });

  test("resolves the second activity group by its index", () => {
    // A text block closes the first activity group, so the second reasoning run
    // lands at group index 2.
    seed([
      msg({
        contentBlocks: [
          { type: "thinking", thinking: "run-A" },
          { type: "text", text: "interlude" },
          { type: "thinking", thinking: "run-B" },
        ],
      }),
    ]);
    expect(render(() => useLiveThinkingText("m1", 0)).result.current).toBe(
      "run-A",
    );
    expect(render(() => useLiveThinkingText("m1", 2)).result.current).toBe(
      "run-B",
    );
  });

  test("updates live as the store's thinking grows", () => {
    seed([msg({ contentBlocks: [{ type: "thinking", thinking: "partial" }] })]);
    const { result } = render(() => useLiveThinkingText("m1", 0));
    expect(result.current).toBe("partial");

    seed([
      msg({ contentBlocks: [{ type: "thinking", thinking: "partial and more" }] }),
    ]);
    expect(result.current).toBe("partial and more");
  });

  test("resolves a message by a merged alias id", () => {
    seed([
      msg({
        id: "server-id",
        mergedMessageIds: ["optimistic-id"],
        contentBlocks: [{ type: "thinking", thinking: "aliased" }],
      }),
    ]);
    const { result } = render(() => useLiveThinkingText("optimistic-id", 0));
    expect(result.current).toBe("aliased");
  });

  test("resolves a committed message from the materialized snapshot", () => {
    // Regression: when a turn finishes, its row lives in the materialized
    // snapshot. The drawer must resolve the full reasoning from there rather
    // than freezing on its stale open-time snapshot.
    seed([]);
    seedHistory([
      msg({
        contentBlocks: [
          { type: "thinking", thinking: "the whole reasoning chain" },
        ],
      }),
    ]);
    const { result } = render(() => useLiveThinkingText("m1", 0));
    expect(result.current).toBe("the whole reasoning chain");
  });

  test("reflects the latest folded content for a streaming row", () => {
    // Mid-stream the reducer keeps folding deltas onto the row in the snapshot,
    // so the drawer reads the freshest reasoning, not an earlier copy.
    seedHistory([
      msg({ contentBlocks: [{ type: "thinking", thinking: "stale snapshot" }] }),
    ]);
    seed([
      msg({
        contentBlocks: [{ type: "thinking", thinking: "live, still growing" }],
      }),
    ]);
    const { result } = render(() => useLiveThinkingText("m1", 0));
    expect(result.current).toBe("live, still growing");
  });
});
