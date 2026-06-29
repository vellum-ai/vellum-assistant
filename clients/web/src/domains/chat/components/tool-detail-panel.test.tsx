/**
 * Tests for `ToolDetailPanel` — the side-drawer body for a tool-call step.
 *
 * Runs under happy-dom (see clients/web/test-setup.ts) so we can render
 * interactively and assert click / clipboard behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render as rtlRender } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// `ToolDetailPanel`'s thinking variant subscribes to the chat-session store,
// which transitively pulls in the generated daemon SDK. Stub every endpoint it
// exports so the module loads, then import dynamically so the mock is registered
// first. Mirrors the comprehensive mock in `multi-activity-group.test.tsx`.
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

const { ToolDetailPanel } = await import(
  "@/domains/chat/components/tool-detail-panel"
);
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);
import type { ToolDetailPayload } from "@/stores/viewer-store";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";

/** Wrap messages into a materialized-snapshot page. */
function snap(messages: DisplayMessage[]): PaginatedHistoryResult {
  return {
    messages,
    seq: null,
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
  };
}

const noop = () => {};

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(ui, { wrapper });

/**
 * Seed a committed message so the drawer's transcript resolves it. History now
 * folds into the materialized snapshot, so this writes the snapshot.
 */
function seedHistory(messages: DisplayMessage[]) {
  // History now folds into the materialized snapshot — the single source the
  // drawer reads — so seed it there.
  useChatSessionStore.setState({ snapshot: snap(messages) });
}

function makeDetail(overrides: Partial<ToolDetailPayload> = {}): ToolDetailPayload {
  return {
    toolCallId: "tc-1",
    toolName: "subagent_spawn",
    title: "Spawning subagent",
    activity: "Spawning subagent to research Toronto's location",
    input: { label: "toronto-location", role: "researcher" },
    result: '{"summary":"Toronto is in Ontario, Canada."}',
    status: "completed",
    riskLevel: "low",
    ...overrides,
  };
}

let writeText: ReturnType<typeof mock>;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  writeText = mock(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
  });
  queryClient.clear();
});

describe("ToolDetailPanel", () => {
  test("renders the activity title, friendly tool name, input JSON and output", () => {
    const { getByText, getAllByText, container } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={noop} />,
    );

    // Activity renders in both the header title and the technical-details body.
    expect(
      getAllByText("Spawning subagent to research Toronto's location").length,
    ).toBeGreaterThan(0);
    // Friendly tool name (title-cased from snake_case).
    expect(getByText("Subagent Spawn")).toBeDefined();
    // Input JSON + output appear inside <pre> blocks.
    const text = container.textContent ?? "";
    expect(text).toContain('"toronto-location"');
    expect(text).toContain("Toronto is in Ontario, Canada.");
  });

  test("hides the Output section when result is empty", () => {
    const { queryByText } = render(
      <ToolDetailPanel detail={makeDetail({ result: "" })} onClose={noop} />,
    );

    expect(queryByText("Output")).toBeNull();
  });

  test("hides the Output section when result is undefined", () => {
    const { queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "completed" })}
        onClose={noop}
      />,
    );

    expect(queryByText("Output")).toBeNull();
  });

  test("shows a Running placeholder while running with no result", () => {
    const { getByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "running" })}
        onClose={noop}
      />,
    );

    expect(getByText("Output")).toBeDefined();
    expect(getByText("Running…")).toBeDefined();
  });

  test("clicking close fires onClose", () => {
    const onClose = mock(() => {});
    const { getByLabelText } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={onClose} />,
    );

    fireEvent.click(getByLabelText("Close tool details"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("copy button writes the content to the clipboard", () => {
    const { getAllByLabelText } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={noop} />,
    );

    // Two copy buttons: one for input, one for output.
    const copyButtons = getAllByLabelText("Copy");
    expect(copyButtons.length).toBe(2);

    fireEvent.click(copyButtons[0]!);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  test("thinking variant renders the reasoning markdown without input/output sections", () => {
    const detail = makeDetail({
      kind: "thinking",
      title: "Thinking",
      thinkingText: "I should first check the directory listing.",
    });
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    // Title + full reasoning text are present.
    expect(getByText("Thinking")).toBeDefined();
    expect(
      getByText("I should first check the directory listing."),
    ).toBeDefined();
    // No tool sections.
    expect(queryByText("Technical details")).toBeNull();
    expect(queryByText("Output")).toBeNull();
    // No risk badge.
    expect(queryByText("Subagent Spawn")).toBeNull();
  });

  test("thinking variant close button fires onClose", () => {
    const onClose = mock(() => {});
    const detail = makeDetail({
      kind: "thinking",
      title: "Thinking",
      thinkingText: "Reasoning.",
    });
    const { getByLabelText } = render(
      <ToolDetailPanel detail={detail} onClose={onClose} />,
    );

    fireEvent.click(getByLabelText("Close tool details"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("thinking variant streams live reasoning from the chat-session store", () => {
    act(() => {
      useChatSessionStore.setState({
        snapshot: snap([
          {
            id: "m1",
            role: "assistant",
            contentBlocks: [{ type: "thinking", thinking: "live reasoning" }],
          },
        ] as DisplayMessage[]),
      });
    });
    const detail = makeDetail({
      kind: "thinking",
      title: "Thought process",
      messageId: "m1",
      thinkingGroupIndex: 0,
      thinkingText: "stale snapshot",
    });
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );

    // The live store text wins over the open-time snapshot.
    expect(getByText("live reasoning")).toBeDefined();
    expect(queryByText("stale snapshot")).toBeNull();

    // Growing the store message updates the already-open drawer.
    act(() => {
      useChatSessionStore.setState({
        snapshot: snap([
          {
            id: "m1",
            role: "assistant",
            contentBlocks: [
              { type: "thinking", thinking: "live reasoning, extended" },
            ],
          },
        ] as DisplayMessage[]),
      });
    });
    expect(getByText("live reasoning, extended")).toBeDefined();
  });

  test("thinking variant falls back to the snapshot when the message is absent", () => {
    const detail = makeDetail({
      kind: "thinking",
      title: "Thought process",
      messageId: "missing",
      thinkingGroupIndex: 0,
      thinkingText: "snapshot fallback",
    });
    const { getByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );
    expect(getByText("snapshot fallback")).toBeDefined();
  });

  test("thinking variant keeps the full reasoning from the committed snapshot", () => {
    // When a turn finishes, the committed row lives in the materialized
    // snapshot. The drawer must keep rendering the full reasoning resolved from
    // there, not snap back to the truncated open-time snapshot.
    seedHistory([
      {
        id: "m1",
        role: "assistant",
        contentBlocks: [
          { type: "thinking", thinking: "the full committed reasoning" },
        ],
      } as DisplayMessage,
    ]);
    const detail = makeDetail({
      kind: "thinking",
      title: "Thought process",
      messageId: "m1",
      thinkingGroupIndex: 0,
      thinkingText: "stale partial snapshot",
    });
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );
    expect(getByText("the full committed reasoning")).toBeDefined();
    expect(queryByText("stale partial snapshot")).toBeNull();
  });

  test("thinking variant selects a single reasoning segment by item index", () => {
    act(() => {
      useChatSessionStore.setState({
        snapshot: snap([
          {
            id: "m1",
            role: "assistant",
            contentBlocks: [
              { type: "thinking", thinking: "segment one" },
              {
                type: "tool_use",
                toolCall: { id: "t1", name: "bash", input: {} },
              },
              { type: "thinking", thinking: "segment two" },
            ],
          },
        ] as DisplayMessage[]),
      });
    });
    const detail = makeDetail({
      kind: "thinking",
      title: "Thinking",
      messageId: "m1",
      thinkingGroupIndex: 0,
      thinkingItemIndex: 1,
      thinkingText: "ignored snapshot",
    });
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={detail} onClose={noop} />,
    );
    expect(getByText("segment two")).toBeDefined();
    expect(queryByText("segment one")).toBeNull();
  });
});
