/**
 * Tests for the unified `MultiActivityGroup` dispatcher.
 *
 * Covers the rendering contract:
 *  - Non-web tool groups (bash, read, MCP, etc.) render via the shared
 *    `ToolProgressCardShell` header with `useToolCallCardData`-derived
 *    carousel text and step-count pill; clicking the header toggles the
 *    activity-steps side panel (the timeline no longer expands in place).
 *  - A LONE purely-web group (one web tool call) renders the inline,
 *    expand-in-place `SingleActivity variant="web"` link.
 *  - A GROUPED (2+) purely-web group and mixed groups (web + non-web) render
 *    through the unified header.
 *  - A pending confirmation in the group short-circuits to the inline
 *    approve/deny UI rather than the progress-card chrome.
 *  - A `subagent_spawn`-only group renders `null` (the inline subagent card
 *    handles spawned subagents at the transcript level).
 *  - Unknown-command nudges render beneath the header.
 */

import { type ComponentProps } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardItem } from "@/domains/chat/utils/tool-call-card-utils";
import { toolCallStatusWireFields } from "@/domains/chat/utils/message-test-helpers";

// The viewer store and chat-session-store (pulled in transitively) import the
// generated daemon SDK, which isn't built in CI/worktree checkouts. Stub all
// endpoints so the module loads; the card never invokes them.
// We read the real module's export names and build a stub object dynamically.
const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
const sdkMock = Object.fromEntries(exportNames.map((n) => [n, sdkStub]));
mock.module("@/generated/daemon/sdk.gen", () => sdkMock);

const { MultiActivityGroup } = await import(
  "@/domains/chat/components/multi-activity-group/multi-activity-group"
);
const { useViewerStore } = await import("@/stores/viewer-store");
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);

afterEach(() => {
  cleanup();
  // Reset drawer state and expansion state between tests so assertions
  // don't bleed across cases.
  useViewerStore.setState({
    activeToolDetail: null,
    activeActivitySteps: null,
    mainView: "chat",
  });
  useChatSessionStore.setState({
    expandedCardIds: new Map(),
    expandedToolCallIds: new Set(),
  });
});

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & {
    id: string;
    name: string;
    status?: "running" | "completed" | "error";
  },
): ChatMessageToolCall {
  const { status = "completed", ...rest } = overrides;
  return {
    input: {},
    ...toolCallStatusWireFields(status),
    ...rest,
  };
}

function renderCard(
  toolCalls: ChatMessageToolCall[],
  overrides: Partial<
    ComponentProps<typeof MultiActivityGroup>
  > = {},
) {
  return render(
    <MultiActivityGroup
      toolCalls={toolCalls}
      {...overrides}
    />,
  );
}

describe("MultiActivityGroup — non-web tool group", () => {
  test("terminal header promotes the bash command into the carousel", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "git status" },
      }),
    ];
    const { getByRole, getByText, getByTestId, queryByTestId, queryByText } = renderCard(toolCalls);
    // The unified group mounts the shared shell wrapper.
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    // The header carousels the live step: the tool's "Working" title paired
    // with the `command` input. The timeline lives in the side panel, so no
    // step pills render inline.
    expect(getByText("Working")).toBeTruthy();
    expect(getByText("git status")).toBeTruthy();
    expect(getByRole("button", { name: /view steps/i })).toBeTruthy();
    expect(queryByTestId("tool-step-pill")).toBeNull();
    // Single-step groups suppress the count pill — it would just duplicate
    // the carousel title. Pill returns at 2+ steps.
    expect(queryByText("1 step")).toBeNull();
  });

  test("carousels the live step in the header while streaming", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "git status" },
      }),
    ];
    const { getByText, queryByTestId } = renderCard(toolCalls);
    // While the run is in flight the header carousels the live step: the
    // "Working" title (rendered through the streaming shimmer) paired with
    // the running command.
    expect(getByText("Working")).toBeTruthy();
    expect(getByText("git status")).toBeTruthy();
    // The timeline lives in the side panel — no step rows inline.
    expect(queryByTestId("tool-step-pill")).toBeNull();
  });

  test("renders no status indicator while running — the shimmering title is the signal", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "bash", status: "running" }),
    ];
    const { queryByTestId } = renderCard(toolCalls);
    expect(queryByTestId("tool-progress-card-status-indicator")).toBeNull();
  });

  test("uses the complete indicator once every tool call is terminal", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "bash", status: "completed" }),
    ];
    const { getByTestId } = renderCard(toolCalls);
    const indicator = getByTestId("tool-progress-card-status-indicator");
    expect(indicator.tagName.toLowerCase()).toBe("svg");
    expect(indicator.getAttribute("data-state")).toBe("complete");
  });
});

describe("MultiActivityGroup — header opens the activity-steps panel", () => {
  test("clicking the header opens the steps side panel with the group payload", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "git status" },
        startedAt: 0,
        completedAt: 1000,
      }),
      makeToolCall({
        id: "tc-2",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 1000,
        completedAt: 2000,
      }),
    ];
    const { getByRole } = renderCard(toolCalls, {
      messageId: "m1",
      groupIndex: 2,
    });
    fireEvent.click(getByRole("button", { name: /view steps/i }));
    const state = useViewerStore.getState();
    expect(state.mainView).toBe("activity-steps");
    expect(state.activeActivitySteps).not.toBeNull();
    expect(state.activeActivitySteps?.messageId).toBe("m1");
    expect(state.activeActivitySteps?.groupIndex).toBe(2);
    expect(state.activeActivitySteps?.toolCalls.map((tc) => tc.id)).toEqual([
      "tc-1",
      "tc-2",
    ]);
    // The snapshot items ride along for identity-less fallback rendering.
    expect(state.activeActivitySteps?.items.length).toBe(2);
  });

  test("clicking the header again closes the panel (toggle)", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "git status" },
      }),
      makeToolCall({
        id: "tc-2",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
      }),
    ];
    const { getByRole } = renderCard(toolCalls, {
      messageId: "m1",
      groupIndex: 0,
    });
    const header = getByRole("button", { name: /view steps/i });
    fireEvent.click(header);
    expect(useViewerStore.getState().mainView).toBe("activity-steps");
    fireEvent.click(header);
    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeActivitySteps).toBeNull();
  });

  test("no in-place expansion: clicking the header renders no inline step pills", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "git status" },
      }),
    ];
    const { getByRole, queryByTestId } = renderCard(toolCalls);
    fireEvent.click(getByRole("button", { name: /view steps/i }));
    expect(queryByTestId("tool-step-pill")).toBeNull();
    expect(queryByTestId("phase-header")).toBeNull();
  });
});

describe("MultiActivityGroup — lone web tool group", () => {
  test("a LONE web_search renders the inline web link, not a boxed/unified card", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "web_search",
        status: "running",
        input: { query: "tigers" },
      }),
    ];
    const { getByTestId, queryByTestId } = renderCard(toolCalls);
    // A lone purely-web group renders the inline, expand-in-place link.
    expect(getByTestId("inline-web-link")).toBeTruthy();
    // It is NOT the boxed web-search card nor the unified shell.
    expect(queryByTestId("web-search-progress-card")).toBeNull();
    expect(queryByTestId("tool-progress-card-shell")).toBeNull();
  });
});

describe("MultiActivityGroup — grouped web tool group", () => {
  test("a GROUPED (2+) purely-web group renders the unified shell", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "web_search",
        status: "running",
        input: { query: "tigers" },
      }),
      makeToolCall({
        id: "tc-2",
        name: "web_search",
        status: "running",
        input: { query: "lions" },
      }),
    ];
    const { getByTestId, queryByTestId } = renderCard(toolCalls);
    // Grouped purely-web flows through the unified bare activity header.
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    // The inline lone-web link is only for the single-call case.
    expect(queryByTestId("inline-web-link")).toBeNull();
  });
});

describe("MultiActivityGroup — mixed group", () => {
  test("web_search + bash falls through to the unified shell with the step-count pill", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "web_search",
        status: "running",
        input: { query: "tigers" },
      }),
      makeToolCall({
        id: "tc-2",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByText, getByTestId } = renderCard(toolCalls);
    // Unified shell — the legacy web-search card bails on mixed groups.
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    expect(getByText("2 steps")).toBeTruthy();
  });
});

describe("MultiActivityGroup — confirmation short-circuit", () => {
  test("a tool call with pendingConfirmation renders the inline approve/deny UI, not the progress card", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "rm -rf /" },
        pendingConfirmation: {
          requestId: "req-1",
          title: "Allow bash command?",
        },
      }),
    ];
    const { getByText, queryByTestId } = renderCard(toolCalls, {
      onConfirmationSubmit: () => {},
    });
    // The inline confirmation card is mounted via ToolCallChip — its title
    // and Allow/Deny buttons should appear.
    expect(getByText("Allow bash command?")).toBeTruthy();
    expect(getByText("Allow")).toBeTruthy();
    expect(getByText("Deny")).toBeTruthy();
    // The unified shell is NOT mounted — confirmation has its own chrome.
    expect(queryByTestId("tool-progress-card-shell")).toBeNull();
  });
});

describe("MultiActivityGroup — subagent_spawn filtering", () => {
  test("renders null for a single subagent_spawn group (inline card handles it)", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "subagent_spawn",
        status: "running",
        input: { label: "Investigate logs" },
      }),
    ];
    const { container, queryByTestId } = renderCard(toolCalls);
    expect(queryByTestId("tool-progress-card-shell")).toBeNull();
    expect(queryByTestId("inline-web-link")).toBeNull();
    // No DOM produced at all.
    expect(container.firstChild).toBeNull();
  });

  test("renders null for a multi subagent_spawn group (no double render)", () => {
    // 2+ spawn-only calls reduce to zero renderable steps — the data layer
    // filters `subagent_spawn`, so nothing renders here on top of the
    // transcript-level inline cards.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "subagent_spawn",
        status: "running",
        input: { label: "First" },
      }),
      makeToolCall({
        id: "tc-2",
        name: "subagent_spawn",
        status: "running",
        input: { label: "Second" },
      }),
    ];
    const { container, queryByTestId } = renderCard(toolCalls);
    expect(queryByTestId("tool-progress-card-shell")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  test("subagent_spawn alongside another tool renders only the non-spawn step", () => {
    // Mixed groups still produce a unified header so users see the non-spawn
    // tools. The spawn itself is suppressed (rendered inline elsewhere) so
    // the header summarises one step, not two.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "subagent_spawn",
        status: "running",
        input: { label: "Investigate logs" },
      }),
      makeToolCall({
        id: "tc-2",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByTestId, queryByText } = renderCard(toolCalls);
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    // Single non-spawn tool call → step pill suppressed (only fires at 2+).
    expect(queryByText(/^\d+ steps?$/)).toBeNull();
    // No "Spawning subagent" content in the header.
    expect(queryByText(/Spawning subagent/i)).toBeNull();
  });
});

describe("MultiActivityGroup — unknown-command nudge", () => {
  test("renders the 'Create a rule' nudge for tool calls flagged as unknown", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "frobnicate" },
      }),
      makeToolCall({
        id: "tc-2",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
      }),
    ];
    const { getByText } = renderCard(toolCalls, {
      unknownNudgeToolCallIds: new Set(["tc-1"]),
      onOpenRuleEditor: () => {},
      onDismissUnknownNudge: () => {},
    });
    expect(getByText("This command wasn't recognized.")).toBeTruthy();
    expect(getByText("Create a rule")).toBeTruthy();
    expect(getByText("to classify it for next time.")).toBeTruthy();
  });

  test("'Create a rule' click invokes onOpenRuleEditor with the tool call's context", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "frobnicate" },
        riskLevel: "high",
        riskReason: "unrecognized command",
        riskAllowlistOptions: [],
        scopeOptions: [],
        riskDirectoryScopeOptions: [],
      }),
      makeToolCall({
        id: "tc-2",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
      }),
    ];
    let captured: { toolName?: string; riskLevel?: string } = {};
    const { getByText } = renderCard(toolCalls, {
      unknownNudgeToolCallIds: new Set(["tc-1"]),
      onOpenRuleEditor: (ctx) => {
        captured = { toolName: ctx.toolName, riskLevel: ctx.riskLevel };
      },
      onDismissUnknownNudge: () => {},
    });
    fireEvent.click(getByText("Create a rule"));
    expect(captured.toolName).toBe("bash");
    expect(captured.riskLevel).toBe("high");
  });

  test("dismiss-X button invokes onDismissUnknownNudge with the tool call id", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "frobnicate" },
      }),
      makeToolCall({
        id: "tc-2",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
      }),
    ];
    const dismissed: { value: string | null } = { value: null };
    const { getByLabelText } = renderCard(toolCalls, {
      unknownNudgeToolCallIds: new Set(["tc-1"]),
      onOpenRuleEditor: () => {},
      onDismissUnknownNudge: (id) => {
        dismissed.value = id;
      },
    });
    fireEvent.click(getByLabelText("Dismiss"));
    expect(dismissed.value).toBe("tc-1");
  });

  test("does not render the nudge for tool calls not in the set", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
      }),
    ];
    const { queryByText } = renderCard(toolCalls, {
      unknownNudgeToolCallIds: new Set([]),
      onOpenRuleEditor: () => {},
    });
    expect(queryByText("This command wasn't recognized.")).toBeNull();
  });
});

describe("MultiActivityGroup — lone web group error chrome", () => {
  test("a LONE errored web_search renders the inline link in its error state", () => {
    // An errored web_search renders the inline lone-web link with the
    // negative tone (the unified `error`/`denied` state collapses into the
    // link's `error` state).
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "web_search",
        status: "error",
        input: { query: "tigers" },
        activityMetadata: {
          webSearch: {
            query: "tigers",
            provider: "anthropic-native",
            resultCount: 0,
            durationMs: 200,
            results: [],
            errorMessage: "Provider returned max_uses_exceeded.",
          },
        },
      }),
    ];
    // Expand the inline link so the error row is in the DOM.
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const { getByTestId, getAllByText } = renderCard(toolCalls);
    const link = getByTestId("inline-web-link");
    expect(link.className).toContain("text-[var(--system-negative-strong)]");
    // The error row renders the provider's failure message (the same copy also
    // backs the header info slot, so it appears more than once).
    expect(getByTestId("web-search-error-chip")).toBeTruthy();
    expect(
      getAllByText("Provider returned max_uses_exceeded.").length,
    ).toBeGreaterThan(0);
  });
});

describe("MultiActivityGroup — ordered thinking items", () => {
  test("thinking items count toward the header's step tally", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: "Let me check the directory first." },
      { kind: "toolCall", toolCall: toolCalls[0]! },
    ];
    const { getByText } = renderCard(toolCalls, { items });
    // The step count reflects the interleaved thinking step.
    expect(getByText("2 steps")).toBeTruthy();
  });

  test("ordered items ride into the steps-panel payload", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
      }),
    ];
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: "Let me check the directory first." },
      { kind: "toolCall", toolCall: toolCalls[0]! },
      { kind: "thinking", text: "Now I know what's there." },
    ];
    const { getByRole } = renderCard(toolCalls, { items });
    fireEvent.click(getByRole("button", { name: /view steps/i }));
    const payload = useViewerStore.getState().activeActivitySteps;
    expect(payload?.items.map((i) => i.kind)).toEqual([
      "thinking",
      "toolCall",
      "thinking",
    ]);
  });
});

describe("MultiActivityGroup — header reflects the latest step", () => {
  test("a run ending in a thinking step shows 'Thinking' + the thinking text in the header", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "read_file",
        status: "completed",
        input: { path: "/tmp/state.txt" },
        startedAt: 0,
        completedAt: 100,
      }),
    ];
    const items: ToolCallCardItem[] = [
      { kind: "toolCall", toolCall: toolCalls[0]! },
      { kind: "thinking", text: "Now I understand the current state." },
    ];
    const { getByText, getByTestId } = renderCard(toolCalls, { items });
    // The header carousels to the latest (thinking) step.
    expect(getByText("Thinking")).toBeTruthy();
    expect(getByText("Now I understand the current state.")).toBeTruthy();
    // The brain glyph renders as an <svg> inside the header carousel.
    const shell = getByTestId("tool-progress-card-shell");
    expect(shell.querySelector("svg")).toBeTruthy();
  });

  test("a run ending in a tool step keeps the tool title/info in the header", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "echo hi" },
        startedAt: 0,
        completedAt: 100,
      }),
    ];
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: "Let me check the directory first." },
      { kind: "toolCall", toolCall: toolCalls[0]! },
    ];
    const { getByText, queryByText } = renderCard(toolCalls, { items });
    // The header carousels the live step: the "Working" title paired with
    // the command.
    expect(getByText("Working")).toBeTruthy();
    expect(getByText("echo hi")).toBeTruthy();
    // The leading thinking text is NOT promoted into the header (it's a
    // panel step only).
    expect(queryByText("Let me check the directory first.")).toBeNull();
  });
});
