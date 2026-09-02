/**
 * Tests for `ToolDetailPanel` — the side-drawer body for a tool-call step.
 *
 * Runs under happy-dom (see clients/web/test-setup.ts) so we can render
 * interactively and assert click / clipboard behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
} from "@testing-library/react";
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

const { ToolDetailPanel } =
  await import("@/domains/chat/components/tool-detail-panel");
const { useChatSessionStore } =
  await import("@/domains/chat/chat-session-store");
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

function makeDetail(
  overrides: Partial<ToolDetailPayload> = {},
): ToolDetailPayload {
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

    // The header owns the activity sentence, and the body does not repeat it.
    expect(
      getAllByText("Spawning subagent to research Toronto's location"),
    ).toHaveLength(1);
    // Friendly tool name (title-cased from snake_case).
    expect(getByText("Subagent Spawn")).toBeDefined();
    // Input JSON + output appear inside <pre> blocks.
    const text = container.textContent ?? "";
    expect(text).toContain('"toronto-location"');
    expect(text).toContain("Toronto is in Ontario, Canada.");
  });

  test("omits the Technical details label", () => {
    const { queryByText } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={noop} />,
    );

    expect(queryByText("Technical details")).toBeNull();
  });

  test("renders the Risk Level notice with the tolerance hint but not the raw reason", () => {
    const { getByTestId, getByText, queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ riskReason: "File edit (default)" })}
        onClose={noop}
      />,
    );

    expect(getByText("Risk Level")).toBeDefined();
    expect(getByTestId("risk-notice").getAttribute("data-risk-level")).toBe(
      "low",
    );
    // Level and tolerance read as one sentence inside the notice.
    expect(
      getByText("Low → Auto-approved at Conservative tolerance or higher"),
    ).toBeDefined();
    // The classifier's rule-match string is internal jargon — never shown.
    expect(queryByText("File edit (default)")).toBeNull();
    // The trust-rule affordance was removed from the drawer.
    expect(queryByText("Create Trust Rule")).toBeNull();
  });

  test("hides the Risk Level section when the call has no risk level", () => {
    const { queryByText, queryByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({ riskLevel: undefined })}
        onClose={noop}
      />,
    );

    expect(queryByText("Risk Level")).toBeNull();
    expect(queryByTestId("risk-notice")).toBeNull();
  });

  test("does not render a Create Trust Rule button even when the call resolves live", () => {
    seedHistory([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [{ id: "tc-1", name: "subagent_spawn", riskLevel: "low" }],
      } as DisplayMessage,
    ]);
    const { queryByText } = render(
      <ToolDetailPanel detail={makeDetail()} onClose={noop} />,
    );

    expect(queryByText("Create Trust Rule")).toBeNull();
  });

  test("reports an empty result rather than dropping the Output section", () => {
    const { getByText, getByTestId } = render(
      <ToolDetailPanel detail={makeDetail({ result: "" })} onClose={noop} />,
    );

    expect(getByText("Output")).toBeDefined();
    expect(getByTestId("tool-output-notice").textContent).toBe(
      "The tool returned no output.",
    );
  });

  test("says a denied call did not run", () => {
    const { getByText, getByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "denied" })}
        onClose={noop}
      />,
    );

    expect(getByText("Output")).toBeDefined();
    expect(getByTestId("tool-output-notice").textContent).toBe(
      "This tool call was not approved, so it did not run.",
    );
  });

  test("picks up a denial that lands while the drawer is open", () => {
    // The payload was captured before the guardian answered, so the snapshot
    // still says the call was running. The live tool call carries the decision.
    seedHistory([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [
          {
            id: "tc-1",
            name: "subagent_spawn",
            confirmationDecision: "denied",
          },
        ],
      } as DisplayMessage,
    ]);
    const { getByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "running" })}
        onClose={noop}
      />,
    );

    expect(getByTestId("tool-output-notice").textContent).toBe(
      "This tool call was not approved, so it did not run.",
    );
  });

  test("treats a timed-out confirmation as not approved", () => {
    seedHistory([
      {
        id: "m1",
        role: "assistant",
        toolCalls: [
          {
            id: "tc-1",
            name: "subagent_spawn",
            confirmationDecision: "timed_out",
          },
        ],
      } as DisplayMessage,
    ]);
    const { getByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "running" })}
        onClose={noop}
      />,
    );

    expect(getByTestId("tool-output-notice").textContent).toBe(
      "This tool call was not approved, so it did not run.",
    );
  });

  test("clamps a long result behind Show more", () => {
    const long = "a line of output\n".repeat(200);
    const { getByText, queryByText } = render(
      <ToolDetailPanel detail={makeDetail({ result: long })} onClose={noop} />,
    );

    const toggle = getByText("Show more");
    expect(toggle).toBeDefined();
    act(() => {
      fireEvent.click(toggle);
    });
    expect(getByText("Show less")).toBeDefined();
    expect(queryByText("Show more")).toBeNull();
  });

  test("leaves a short result unclamped", () => {
    const { queryByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: "two words" })}
        onClose={noop}
      />,
    );

    expect(queryByText("Show more")).toBeNull();
  });

  test("reports no output for a call that finished without a result", () => {
    const { getByText, getByTestId } = render(
      <ToolDetailPanel
        detail={makeDetail({ result: undefined, status: "completed" })}
        onClose={noop}
      />,
    );

    expect(getByText("Output")).toBeDefined();
    expect(getByTestId("tool-output-notice").textContent).toBe(
      "The tool returned no output.",
    );
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

  test("collapses whitespace in the header title", () => {
    // The activity sentence is model-written; a newline in it would render as
    // a gap in a single-line header.
    const { container } = render(
      <ToolDetailPanel
        detail={makeDetail({
          activity: "  Reading the risk helpers\n  and the badge styles  ",
        })}
        onClose={noop}
      />,
    );

    // Asserted on the raw node rather than through `getByText`, whose default
    // normalizer collapses whitespace itself and so cannot tell a sanitized
    // title from an unsanitized one.
    const heading = container.querySelector("[title]");
    expect(heading?.getAttribute("title")).toBe(
      "Reading the risk helpers and the badge styles",
    );
    expect(heading?.textContent).toBe(
      "Reading the risk helpers and the badge styles",
    );
  });

  test("falls back to the phase title when there is no activity", () => {
    const { getByText } = render(
      <ToolDetailPanel
        detail={makeDetail({ activity: "", title: "Spawning subagent" })}
        onClose={noop}
      />,
    );

    expect(getByText("Spawning subagent")).toBeDefined();
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
