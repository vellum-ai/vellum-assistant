/**
 * Tests for `useLiveThinkingText` — the selector that re-derives a thinking
 * drawer's reasoning text from the live chat-session store so an open drawer
 * streams instead of freezing its open-time snapshot.
 *
 * The chat-session store transitively pulls in the generated daemon SDK. Stub
 * every endpoint it exports so the module loads; nothing here invokes them.
 * Mirrors the comprehensive mock in `multi-activity-group.test.tsx`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

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

function seed(messages: DisplayMessage[]) {
  act(() => {
    useChatSessionStore.setState({ liveTurn: messages });
  });
}

function msg(overrides: Partial<DisplayMessage>): DisplayMessage {
  return { id: "m1", role: "assistant", ...overrides } as DisplayMessage;
}

afterEach(() => {
  cleanup();
  act(() => {
    useChatSessionStore.setState({ liveTurn: [] });
  });
});

describe("useLiveThinkingText", () => {
  test("returns null without a message id or group index", () => {
    seed([msg({ contentBlocks: [{ type: "thinking", thinking: "a" }] })]);
    expect(renderHook(() => useLiveThinkingText(undefined, 0)).result.current).toBeNull();
    expect(renderHook(() => useLiveThinkingText("m1", undefined)).result.current).toBeNull();
  });

  test("returns null when the message is absent", () => {
    seed([]);
    const { result } = renderHook(() => useLiveThinkingText("missing", 0));
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
    const { result } = renderHook(() => useLiveThinkingText("m1", 0));
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
    expect(renderHook(() => useLiveThinkingText("m1", 0, 0)).result.current).toBe(
      "first",
    );
    expect(renderHook(() => useLiveThinkingText("m1", 0, 1)).result.current).toBe(
      "second",
    );
  });

  test("returns null for an out-of-range item index", () => {
    seed([msg({ contentBlocks: [{ type: "thinking", thinking: "only" }] })]);
    const { result } = renderHook(() => useLiveThinkingText("m1", 0, 5));
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
    expect(renderHook(() => useLiveThinkingText("m1", 0)).result.current).toBe(
      "run-A",
    );
    expect(renderHook(() => useLiveThinkingText("m1", 2)).result.current).toBe(
      "run-B",
    );
  });

  test("updates live as the store's thinking grows", () => {
    seed([msg({ contentBlocks: [{ type: "thinking", thinking: "partial" }] })]);
    const { result } = renderHook(() => useLiveThinkingText("m1", 0));
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
    const { result } = renderHook(() =>
      useLiveThinkingText("optimistic-id", 0),
    );
    expect(result.current).toBe("aliased");
  });
});
