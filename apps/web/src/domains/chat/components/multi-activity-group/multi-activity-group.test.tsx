/**
 * Tests for the unified `MultiActivityGroup` dispatcher.
 *
 * Covers the post-unification rendering contract:
 *  - Non-web tool groups (bash, read, MCP, etc.) render via the shared
 *    `ToolProgressCardShell` with `useToolCallCardData`-derived header text
 *    and step pill.
 *  - A LONE purely-web group (one web tool call) renders the inline,
 *    expand-in-place `SingleActivity variant="web"` link.
 *  - A GROUPED (2+) purely-web group and mixed groups (web + non-web) render
 *    through the unified shell with one step per tool call in the expanded
 *    body.
 *  - A pending confirmation in the group short-circuits to the inline
 *    approve/deny UI rather than the progress-card chrome.
 *  - A `subagent_spawn`-only group renders `null` (PR 8 wires the inline
 *    subagent card; until then the legacy bottom card handles spawned
 *    subagents).
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
  useViewerStore.setState({ activeToolDetail: null, mainView: "chat" });
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
  test("collapsed terminal card promotes the bash command into the carousel header", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "git status" },
      }),
    ];
    const { getByRole, getByText, getByTestId, queryByTestId, queryByText } = renderCard(toolCalls);
    // The unified card mounts the shared shell wrapper.
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    // The collapsed header carousels the live step: the tool's "Working"
    // title paired with the `command` input. The expanded body is hidden by
    // default, so only the header content is present on mount.
    expect(getByText("Working")).toBeTruthy();
    expect(getByText("git status")).toBeTruthy();
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
    expect(queryByTestId("tool-step-pill")).toBeNull();
    // Single-step cards suppress the count pill — it would just duplicate
    // the carousel title. Pill returns at 2+ steps.
    expect(queryByText("1 step")).toBeNull();
  });

  test("carousels the live step in the collapsed header while streaming", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "git status" },
      }),
    ];
    const { getByText, queryByTestId } = renderCard(toolCalls);
    // While the run is in flight the collapsed header carousels the live
    // step: the "Working" title paired with the running command. The
    // three-dot indicator (verified elsewhere) pairs with this live text.
    expect(getByText("Working")).toBeTruthy();
    expect(getByText("git status")).toBeTruthy();
    // Collapsed by default: no step rows on mount.
    expect(queryByTestId("tool-step-pill")).toBeNull();
  });

  test("keeps loading step rows hidden until the user expands the card", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "git status" },
      }),
    ];
    const { getByRole, getByTestId, queryByTestId } = renderCard(toolCalls);
    expect(queryByTestId("tool-step-pill")).toBeNull();
    fireEvent.click(getByRole("button", { name: /expand steps/i }));
    expect(getByTestId("tool-step-pill")).toBeTruthy();
  });

  test("drops the header's loading dots once expanded — the timeline carries status", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "git status" },
      }),
    ];
    const { getByRole, getByTestId, queryByTestId } = renderCard(toolCalls);
    // Collapsed: the header shows the loading dots (no timeline to carry them).
    expect(getByTestId("tool-progress-card-status-indicator")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /expand steps/i }));
    // Expanded: the header's loading dots are gone; the running phase node in
    // the timeline below carries the live indicator instead.
    expect(queryByTestId("tool-progress-card-status-indicator")).toBeNull();
    expect(
      getByTestId("phase-header-status-icon").children.length,
    ).toBe(3);
  });

  test("keeps the finished checkmark in the header when expanded and complete", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "git status" },
      }),
    ];
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const { getByTestId } = renderCard(toolCalls);
    // Only the loading dots are dropped when expanded — the terminal checkmark
    // still summarises the outcome in the header above the timeline.
    const indicator = getByTestId("tool-progress-card-status-indicator");
    expect(indicator.tagName.toLowerCase()).toBe("svg");
    expect(indicator.getAttribute("data-state")).toBe("complete");
  });

  test("uses the loading indicator while any tool is running", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "bash", status: "running" }),
    ];
    const { getByTestId } = renderCard(toolCalls);
    const indicator = getByTestId("tool-progress-card-status-indicator");
    expect(indicator.tagName).toBe("SPAN");
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

describe("MultiActivityGroup — tool step pill", () => {
  test("non-web tool step renders a tool-step-pill with activity + risk badge", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "git status", activity: "Checking git status" },
        riskLevel: "high",
      }),
    ];
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const { getByTestId } = renderCard(toolCalls);
    const pill = getByTestId("tool-step-pill");
    expect(pill).toBeTruthy();
    // Activity sentence wins over the terse command info (it also surfaces in
    // the carousel header, hence the textContent check on the pill itself).
    expect(pill.textContent).toContain("Checking git status");
    // Risk badge rides along inside the pill.
    expect(getByTestId("risk-badge").getAttribute("data-risk-level")).toBe(
      "high",
    );
  });

  test("clicking the pill calls openToolDetail with the matching tool-call snapshot", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "git status", activity: "Checking git status" },
        result: "On branch main",
        riskLevel: "high",
        riskReason: "writes to disk",
        startedAt: 0,
        completedAt: 1000,
        // Keep the card expanded so the pill is in the DOM post-completion.
      }),
    ];
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const { getByTestId } = renderCard(toolCalls);
    fireEvent.click(getByTestId("tool-step-pill"));
    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail).not.toBeNull();
    expect(detail?.toolCallId).toBe("tc-1");
    expect(detail?.toolName).toBe("bash");
    expect(detail?.input).toEqual({
      command: "git status",
      activity: "Checking git status",
    });
    expect(detail?.result).toBe("On branch main");
    expect(detail?.status).toBe("completed");
    expect(detail?.riskLevel).toBe("high");
    expect(detail?.riskReason).toBe("writes to disk");
    // Opening the drawer flips the main view to the tool-detail surface.
    expect(useViewerStore.getState().mainView).toBe("tool-detail");
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
    // Grouped purely-web flows through the unified bare activity card.
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    // The inline lone-web link is only for the single-call case.
    expect(queryByTestId("inline-web-link")).toBeNull();
  });
});

describe("MultiActivityGroup — mixed group", () => {
  test("web_search + bash falls through to the unified shell with one step per call", () => {
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
    // The previous dispatcher only suppressed `length === 1` spawn-only
    // groups, which meant 2+ spawn calls rendered "Spawning subagent" rows
    // in the unified card on top of the transcript-level inline cards —
    // showing each subagent twice. The data layer now filters
    // `subagent_spawn` out, so this multi-spawn group reduces to zero steps
    // and renders nothing.
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
    // Mixed groups still produce a unified card so users see the non-spawn
    // tools. The spawn itself is suppressed (rendered inline elsewhere) so
    // the shell only shows one step, not two.
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
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const { getByTestId, queryByText } = renderCard(toolCalls);
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    // Single non-spawn tool call → step pill suppressed (only fires at 2+).
    expect(queryByText(/^\d+ steps?$/)).toBeNull();
    // No "Spawning subagent" row in the body.
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
    ];
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
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
    ];
    let captured: { toolName?: string; riskLevel?: string } = {};
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
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
    ];
    const dismissed: { value: string | null } = { value: null };
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
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
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const { queryByText } = renderCard(toolCalls, {
      unknownNudgeToolCallIds: new Set([]),
      onOpenRuleEditor: () => {},
    });
    expect(queryByText("This command wasn't recognized.")).toBeNull();
  });
});

describe("MultiActivityGroup — expansion derived from state", () => {
  test("mounts collapsed while loading", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByRole } = renderCard(toolCalls);
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
  });

  test("mounts collapsed once the card reaches a terminal state", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    const { getByRole } = renderCard(toolCalls);
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
  });

  test("stays collapsed on the loading → complete transition without a user toggle", () => {
    const running = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByRole, rerender } = render(
      <MultiActivityGroup
        toolCalls={running}
      />,
    );
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();

    const completed = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    rerender(
      <MultiActivityGroup
        toolCalls={completed}
      />,
    );
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
  });

  test("user toggle wins after a state transition (manual expand survives → complete)", () => {
    const running = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByRole, rerender } = render(
      <MultiActivityGroup
        toolCalls={running}
      />,
    );
    // Card mounts collapsed; user expands it manually.
    fireEvent.click(getByRole("button", { name: /expand steps/i }));
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();

    // Card transitions to complete — user's explicit "expanded" must win.
    const completed = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    rerender(
      <MultiActivityGroup
        toolCalls={completed}
      />,
    );
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();
  });

  test("persisted expanded=false survives remount of a completed card", () => {
    // Simulates a user who collapsed a running card; after the turn finishes
    // the card remounts in `complete` (e.g. latest-turn → history transition)
    // and must respect the persisted collapse decision.
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", false]]) });
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    const { getByRole } = render(
      <MultiActivityGroup
        toolCalls={toolCalls}
      />,
    );
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
  });

  test("persisted expanded=true overrides the collapsed default on completion", () => {
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    const { getByRole } = render(
      <MultiActivityGroup
        toolCalls={toolCalls}
      />,
    );
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();
  });

  test("persisted expanded=true overrides the collapsed default while loading", () => {
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByRole } = renderCard(toolCalls);
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();
  });

  test("autoExpand opens the current loading card without persisting a user choice", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByRole } = renderCard(toolCalls, {
      autoExpand: true,
    });
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();
    // autoExpand does not persist the choice — store remains empty.
    expect(useChatSessionStore.getState().expandedCardIds.size).toBe(0);
  });

  test("persisted collapse overrides autoExpand", () => {
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", false]]) });
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByRole } = renderCard(toolCalls, {
      autoExpand: true,
    });
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
  });

  test("collapses when autoExpand turns off and the user has not toggled", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByRole, rerender } = render(
      <MultiActivityGroup
        toolCalls={toolCalls}
        autoExpand
      />,
    );
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();

    rerender(
      <MultiActivityGroup
        toolCalls={toolCalls}
        autoExpand={false}
      />,
    );
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
  });
});

describe("MultiActivityGroup — lone web group error chrome", () => {
  test("a LONE errored web_search renders the inline link in its error state", () => {
    // An errored web_search now renders the inline lone-web link with the
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
    // Expand so the error row is in the DOM.
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

describe("MultiActivityGroup — mixed group web_search_error rendering", () => {
  test("renders an ErrorChip (not the default pill) for a web_search_error step in a mixed group", () => {
    // The unified card's `ExpandedStep` previously fell through to
    // `DefaultStepPill` for `web_search_error`, dropping the dedicated
    // error chip. A mixed group exercises the unified-shell path (a lone
    // purely-web group renders the inline link instead).
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
      makeToolCall({
        id: "tc-2",
        name: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 100,
      }),
    ];
    // Force expand so the step body is in the DOM regardless of state.
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const { getByTestId, getByText } = renderCard(toolCalls);
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    expect(getByTestId("web-search-error-chip")).toBeTruthy();
    expect(getByText("Provider returned max_uses_exceeded.")).toBeTruthy();
  });
});

describe("MultiActivityGroup — ordered thinking items", () => {
  test("renders a leading thinking step in the expanded body when supplied via items", () => {
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
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const { getByText } = renderCard(toolCalls, { items });
    // The thinking text appears as a separate step row in the expanded body.
    expect(getByText("Let me check the directory first.")).toBeTruthy();
    // The step count reflects the interleaved thinking step.
    expect(getByText("2 steps")).toBeTruthy();
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
    // Collapsed header carousels to the latest (thinking) step.
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
    // The collapsed header carousels the live step: the "Working" title
    // paired with the command.
    expect(getByText("Working")).toBeTruthy();
    expect(getByText("echo hi")).toBeTruthy();
    // The leading thinking text is NOT promoted into the header (it's a body
    // step only).
    expect(queryByText("Let me check the directory first.")).toBeNull();
  });
});

describe("MultiActivityGroup — thinking pill", () => {
  // A long reasoning text so we can assert hard-cap truncation (60 chars).
  const LONG_THINKING =
    "I should first inspect the repository layout before running anything destructive on disk.";

  test("renders the thinking step as a clickable, truncated tool-step-pill", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: LONG_THINKING },
      { kind: "toolCall", toolCall: toolCalls[0]! },
    ];
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const { getByLabelText } = renderCard(toolCalls, { items });
    // The thinking step renders as a clickable pill (a <button>), not a
    // plain row. Scoped by its aria-label so it isn't confused with the
    // sibling bash tool pill.
    const pill = getByLabelText("View thinking");
    expect(pill.tagName.toLowerCase()).toBe("button");
    // Hard-capped at 60 chars with a trailing ellipsis.
    const text = pill.textContent ?? "";
    expect(text).toContain("…");
    expect(text.length).toBeLessThanOrEqual(60);
    // The full untruncated text is NOT present in the pill.
    expect(text).not.toContain("destructive on disk");
  });

  test("clicking the thinking pill opens the drawer with the full reasoning text", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: LONG_THINKING },
      { kind: "toolCall", toolCall: toolCalls[0]! },
    ];
    useChatSessionStore.setState({ expandedCardIds: new Map([["tc-1", true]]) });
    const { getByLabelText } = renderCard(toolCalls, { items });
    fireEvent.click(getByLabelText("View thinking"));
    const detail = useViewerStore.getState().activeToolDetail;
    expect(detail).not.toBeNull();
    expect(detail?.kind).toBe("thinking");
    expect(detail?.title).toBe("Thinking");
    // Drawer carries the FULL (untruncated) reasoning text.
    expect(detail?.thinkingText).toBe(LONG_THINKING);
    expect(useViewerStore.getState().mainView).toBe("tool-detail");
  });
});
