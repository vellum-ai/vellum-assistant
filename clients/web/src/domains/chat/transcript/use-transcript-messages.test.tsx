import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { DisplayMessage } from "@/domains/chat/types/types";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";

// Stub the history query so the hook reads a fixed cached-history value, with
// no QueryClient provider needed.
const realPaginationModule = await import(
  "@/domains/chat/transcript/use-history-pagination"
);
let historyMessages: DisplayMessage[] = [];
mock.module("@/domains/chat/transcript/use-history-pagination", () => ({
  ...realPaginationModule,
  useHistoryPagination: () =>
    ({ messages: historyMessages }) as unknown as HistoryPaginationResult,
}));

const { useTranscriptMessages } = await import(
  "@/domains/chat/transcript/use-transcript-messages"
);
const { useChatSessionStore } = await import("@/domains/chat/chat-session-store");
const { useClientFeatureFlagStore } = await import(
  "@/stores/client-feature-flag-store"
);

function row(id: string, role: DisplayMessage["role"], text: string): DisplayMessage {
  return {
    id,
    role,
    textSegments: [text],
    contentOrder: [{ type: "text", id: "0" }],
    contentBlocks: [{ type: "text", text }],
    ...(role === "user" ? { clientMessageId: id } : {}),
  };
}

function setFlag(on: boolean) {
  useClientFeatureFlagStore.getState().setFlag("clientSyncSnapshotRender", on);
}

beforeEach(() => {
  historyMessages = [];
  useChatSessionStore.setState({ liveTurn: [], snapshot: null, optimisticSends: [] });
  setFlag(false);
});
afterEach(() => {
  cleanup();
  useChatSessionStore.setState({ liveTurn: [], snapshot: null, optimisticSends: [] });
  setFlag(false);
});

const render = () =>
  renderHook(() => useTranscriptMessages("asst-1", "conv-A")).result;

describe("useTranscriptMessages — render source flag", () => {
  test("flag off: derives from cached history ⊕ liveTurn", () => {
    historyMessages = [row("h1", "assistant", "from history")];
    useChatSessionStore.setState({
      liveTurn: [row("u1", "user", "from liveTurn")],
      snapshot: {
        messages: [row("s1", "assistant", "from snapshot")],
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
        seq: 1,
      },
      optimisticSends: [row("o1", "user", "from optimistic")],
    });

    expect(render().current.map((m) => m.id)).toEqual(["h1", "u1"]);
  });

  test("flag on: derives from snapshot ⊕ optimisticSends", () => {
    historyMessages = [row("h1", "assistant", "from history")];
    useChatSessionStore.setState({
      liveTurn: [row("u1", "user", "from liveTurn")],
      snapshot: {
        messages: [row("s1", "assistant", "from snapshot")],
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
        seq: 1,
      },
      optimisticSends: [row("o1", "user", "from optimistic")],
    });
    setFlag(true);

    expect(render().current.map((m) => m.id)).toEqual(["s1", "o1"]);
  });

  test("flag on with no snapshot yet: shows just the optimistic sends", () => {
    useChatSessionStore.setState({
      snapshot: null,
      optimisticSends: [row("o1", "user", "queued send")],
    });
    setFlag(true);

    expect(render().current.map((m) => m.id)).toEqual(["o1"]);
  });
});
