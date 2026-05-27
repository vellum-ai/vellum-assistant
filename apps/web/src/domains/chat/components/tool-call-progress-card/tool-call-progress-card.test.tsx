/**
 * Tests for the unified `ToolCallProgressCard` dispatcher.
 *
 * Covers the post-unification rendering contract:
 *  - Non-web tool groups (bash, read, MCP, etc.) render via the shared
 *    `ToolProgressCardShell` with `useToolCallCardData`-derived header text
 *    and step pill.
 *  - Web-only groups continue to render through `WebSearchProgressCard` for
 *    regression parity.
 *  - Mixed groups (web + non-web) render through the unified shell with one
 *    step per tool call in the expanded body.
 *  - A pending confirmation in the group short-circuits to the inline
 *    approve/deny UI rather than the progress-card chrome.
 *  - A `subagent_spawn`-only group renders `null` (PR 8 wires the inline
 *    subagent card; until then the legacy bottom card handles spawned
 *    subagents).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { ToolCallProgressCard } from "@/domains/chat/components/tool-call-progress-card/tool-call-progress-card";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

afterEach(() => {
  cleanup();
});

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & {
    id: string;
    toolName: string;
  },
): ChatMessageToolCall {
  return {
    input: {},
    status: "completed",
    ...overrides,
  };
}

function renderCard(
  toolCalls: ChatMessageToolCall[],
  overrides: Partial<
    React.ComponentProps<typeof ToolCallProgressCard>
  > = {},
) {
  return render(
    <ToolCallProgressCard
      toolCalls={toolCalls}
      expandedToolCallIds={new Set()}
      onExpandChange={() => {}}
      expandedCardIds={new Map()}
      {...overrides}
    />,
  );
}

describe("ToolCallProgressCard — non-web tool group", () => {
  test("renders the unified shell with the bash carousel header + step pill", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "running",
        input: { command: "git status" },
      }),
    ];
    const { getAllByText, getByTestId, queryByText } = renderCard(toolCalls);
    // The unified card mounts the shared shell wrapper.
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    // Title comes from `deriveStepLabel("bash")`, info from the `command`
    // input. Title appears twice — once in the carousel header, once in
    // the auto-expanded phase header (the body's phase-grouped layout
    // collapses the single bash step into a "Working (bash)" phase
    // section).
    expect(getAllByText("Working (bash)").length).toBe(2);
    expect(getAllByText("git status").length).toBeGreaterThanOrEqual(1);
    // Single-step cards suppress the count pill — it would just duplicate
    // the carousel title. Pill returns at 2+ steps.
    expect(queryByText("1 step")).toBeNull();
  });

  test("auto-expands while loading so step rows are visible without a click", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "running",
        input: { command: "git status" },
      }),
    ];
    const { getAllByText } = renderCard(toolCalls);
    // Title appears once in the header and once in the expanded body row.
    expect(getAllByText("Working (bash)").length).toBeGreaterThanOrEqual(1);
  });

  test("uses the loading indicator while any tool is running", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "bash", status: "running" }),
    ];
    const { getByTestId } = renderCard(toolCalls);
    const indicator = getByTestId("tool-progress-card-status-indicator");
    expect(indicator.tagName).toBe("SPAN");
  });

  test("uses the complete indicator once every tool call is terminal", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "bash", status: "completed" }),
    ];
    const { getByTestId } = renderCard(toolCalls);
    const indicator = getByTestId("tool-progress-card-status-indicator");
    expect(indicator.tagName.toLowerCase()).toBe("svg");
    expect(indicator.getAttribute("data-state")).toBe("complete");
  });
});

describe("ToolCallProgressCard — web tool group regression", () => {
  test("web_search-only groups still render through WebSearchProgressCard", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
        input: { query: "tigers" },
      }),
    ];
    const { getByTestId, queryByTestId } = renderCard(toolCalls);
    expect(getByTestId("web-search-progress-card")).toBeTruthy();
    // Unified shell is NOT used for purely-web groups — they continue to
    // flow through the dedicated web-search card.
    expect(queryByTestId("tool-progress-card-shell")).toBeNull();
  });
});

describe("ToolCallProgressCard — mixed group", () => {
  test("web_search + bash falls through to the unified shell with one step per call", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
        input: { query: "tigers" },
      }),
      makeToolCall({
        id: "tc-2",
        toolName: "bash",
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

describe("ToolCallProgressCard — confirmation short-circuit", () => {
  test("pendingConfirmationToolCallId renders the inline approve/deny UI, not the progress card", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "running",
        input: { command: "rm -rf /" },
        pendingConfirmation: {
          requestId: "req-1",
          title: "Allow bash command?",
        },
      }),
    ];
    const { getByText, queryByTestId } = renderCard(toolCalls, {
      pendingConfirmationToolCallId: "tc-1",
      isSubmittingConfirmation: false,
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

describe("ToolCallProgressCard — subagent_spawn filtering", () => {
  test("renders null for a single subagent_spawn group (inline card handles it)", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "subagent_spawn",
        status: "running",
        input: { label: "Investigate logs" },
      }),
    ];
    const { container, queryByTestId } = renderCard(toolCalls);
    expect(queryByTestId("tool-progress-card-shell")).toBeNull();
    expect(queryByTestId("web-search-progress-card")).toBeNull();
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
        toolName: "subagent_spawn",
        status: "running",
        input: { label: "First" },
      }),
      makeToolCall({
        id: "tc-2",
        toolName: "subagent_spawn",
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
        toolName: "subagent_spawn",
        status: "running",
        input: { label: "Investigate logs" },
      }),
      makeToolCall({
        id: "tc-2",
        toolName: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByTestId, queryByText } = renderCard(toolCalls);
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    // Single non-spawn tool call → step pill suppressed (only fires at 2+).
    expect(queryByText(/^\d+ steps?$/)).toBeNull();
    // No "Spawning subagent" row in the body.
    expect(queryByText(/Spawning subagent/i)).toBeNull();
  });
});

describe("ToolCallProgressCard — unknown-command nudge", () => {
  test("renders the 'Create a rule' nudge for tool calls flagged as unknown", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "frobnicate" },
      }),
    ];
    const { getByText } = renderCard(toolCalls, {
      unknownNudgeToolCallIds: new Set(["tc-1"]),
      onOpenRuleEditor: () => {},
      onDismissUnknownNudge: () => {},
      // Force the body open so the nudge inside the expanded region is in
      // the DOM regardless of the auto-collapse-on-completion behavior.
      expandedCardIds: new Map([["tc-1", true]]),
    });
    expect(getByText("This command wasn't recognized.")).toBeTruthy();
    expect(getByText("Create a rule")).toBeTruthy();
    expect(getByText("to classify it for next time.")).toBeTruthy();
  });

  test("'Create a rule' click invokes onOpenRuleEditor with the tool call's context", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "frobnicate" },
        riskLevel: "high",
        riskReason: "unrecognized command",
        allowlistOptions: [],
        scopeOptions: [],
        directoryScopeOptions: [],
      }),
    ];
    let captured: { toolName?: string; riskLevel?: string } = {};
    const { getByText } = renderCard(toolCalls, {
      unknownNudgeToolCallIds: new Set(["tc-1"]),
      onOpenRuleEditor: (ctx) => {
        captured = { toolName: ctx.toolName, riskLevel: ctx.riskLevel };
      },
      onDismissUnknownNudge: () => {},
      expandedCardIds: new Map([["tc-1", true]]),
    });
    fireEvent.click(getByText("Create a rule"));
    expect(captured.toolName).toBe("bash");
    expect(captured.riskLevel).toBe("high");
  });

  test("dismiss-X button invokes onDismissUnknownNudge with the tool call id", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "frobnicate" },
      }),
    ];
    const dismissed: { value: string | null } = { value: null };
    const { getByLabelText } = renderCard(toolCalls, {
      unknownNudgeToolCallIds: new Set(["tc-1"]),
      onOpenRuleEditor: () => {},
      onDismissUnknownNudge: (id) => {
        dismissed.value = id;
      },
      expandedCardIds: new Map([["tc-1", true]]),
    });
    fireEvent.click(getByLabelText("Dismiss"));
    expect(dismissed.value).toBe("tc-1");
  });

  test("does not render the nudge for tool calls not in the set", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
      }),
    ];
    const { queryByText } = renderCard(toolCalls, {
      unknownNudgeToolCallIds: new Set([]),
      onOpenRuleEditor: () => {},
      expandedCardIds: new Map([["tc-1", true]]),
    });
    expect(queryByText("This command wasn't recognized.")).toBeNull();
  });
});

describe("ToolCallProgressCard — expansion derived from state", () => {
  test("mounts expanded while loading", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByRole } = renderCard(toolCalls);
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();
  });

  test("collapses automatically once the card reaches a terminal state", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    const { getByRole } = renderCard(toolCalls);
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
  });

  test("auto-collapses on the loading → complete transition without a user toggle", () => {
    const expandedCardIds = new Map<string, boolean>();
    const running = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByRole, rerender } = render(
      <ToolCallProgressCard
        toolCalls={running}
        expandedToolCallIds={new Set()}
        onExpandChange={() => {}}
        expandedCardIds={expandedCardIds}
      />,
    );
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();

    const completed = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    rerender(
      <ToolCallProgressCard
        toolCalls={completed}
        expandedToolCallIds={new Set()}
        onExpandChange={() => {}}
        expandedCardIds={expandedCardIds}
      />,
    );
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
  });

  test("user toggle wins after a state transition (manual expand survives → complete)", () => {
    const expandedCardIds = new Map<string, boolean>();
    const running = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByRole, rerender } = render(
      <ToolCallProgressCard
        toolCalls={running}
        expandedToolCallIds={new Set()}
        onExpandChange={() => {}}
        expandedCardIds={expandedCardIds}
      />,
    );
    // Card mounts expanded; user collapses it manually.
    fireEvent.click(getByRole("button", { name: /collapse steps/i }));
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
    // User expands it back.
    fireEvent.click(getByRole("button", { name: /expand steps/i }));
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();

    // Card transitions to complete — user's explicit "expanded" must win.
    const completed = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    rerender(
      <ToolCallProgressCard
        toolCalls={completed}
        expandedToolCallIds={new Set()}
        onExpandChange={() => {}}
        expandedCardIds={expandedCardIds}
      />,
    );
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();
  });

  test("persisted expanded=false survives remount of a completed card", () => {
    // Simulates a user who collapsed a running card; after the turn finishes
    // the card remounts in `complete` (e.g. latest-turn → history transition)
    // and must respect the persisted collapse decision.
    const expandedCardIds = new Map<string, boolean>([["tc-1", false]]);
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    const { getByRole } = render(
      <ToolCallProgressCard
        toolCalls={toolCalls}
        expandedToolCallIds={new Set()}
        onExpandChange={() => {}}
        expandedCardIds={expandedCardIds}
      />,
    );
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
  });

  test("persisted expanded=true overrides the auto-collapse on completion", () => {
    const expandedCardIds = new Map<string, boolean>([["tc-1", true]]);
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    const { getByRole } = render(
      <ToolCallProgressCard
        toolCalls={toolCalls}
        expandedToolCallIds={new Set()}
        onExpandChange={() => {}}
        expandedCardIds={expandedCardIds}
      />,
    );
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();
  });

  test("isStreaming=true keeps the card expanded after tools complete", () => {
    // Tools finish before the assistant's final response — the card should
    // stay expanded while `isStreaming` is true so the user sees the steps
    // beside the streaming reply, not a prematurely-collapsed card.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    const { getByRole } = renderCard(toolCalls, { isStreaming: true });
    expect(getByRole("button", { name: /collapse steps/i })).toBeTruthy();
  });

  test("isStreaming=false collapses the completed card (regression vs the previous case)", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    const { getByRole } = renderCard(toolCalls, { isStreaming: false });
    expect(getByRole("button", { name: /expand steps/i })).toBeTruthy();
  });
});

describe("ToolCallProgressCard — web group error chrome", () => {
  test("a purely-web group with an errored tool call renders the shell's error icon", () => {
    // Previously the `WebSearchView` recomputed state from raw status only,
    // so an errored web_search rendered the green check (loading → complete)
    // while non-web groups got the red AlertCircle. Now the unified state
    // bubbles up so the icon matches.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "error",
        input: { query: "tigers" },
      }),
    ];
    const { getByTestId } = renderCard(toolCalls);
    const indicator = getByTestId("web-search-status-indicator");
    // lucide `AlertCircle` renders as an <svg>.
    expect(indicator.tagName.toLowerCase()).toBe("svg");
    expect(indicator.getAttribute("data-state")).toBe("error");
  });
});

describe("ToolCallProgressCard — mixed group web_search_error rendering", () => {
  test("renders an ErrorChip (not the default pill) for a web_search_error step in a mixed group", () => {
    // The unified card's `ExpandedStep` previously fell through to
    // `DefaultStepPill` for `web_search_error`, dropping the dedicated
    // error chip the web-search card shows. A mixed group exercises that
    // path since purely-web groups go through `WebSearchProgressCard`.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
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
        toolName: "bash",
        status: "completed",
        input: { command: "ls" },
        startedAt: 0,
        completedAt: 100,
      }),
    ];
    const { getByTestId, getByText } = renderCard(toolCalls, {
      // Force expand so the step body is in the DOM regardless of state.
      expandedCardIds: new Map([["tc-1", true]]),
    });
    expect(getByTestId("tool-progress-card-shell")).toBeTruthy();
    expect(getByTestId("web-search-error-chip")).toBeTruthy();
    expect(getByText("Provider returned max_uses_exceeded.")).toBeTruthy();
  });
});

describe("ToolCallProgressCard — leadingThinkingText", () => {
  test("prepends a thinking step to the expanded body when supplied", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const { getByText, getByText: getByText2 } = renderCard(toolCalls, {
      leadingThinkingText: "Let me check the directory first.",
    });
    // The thinking text appears as a separate step row in the expanded body.
    expect(getByText("Let me check the directory first.")).toBeTruthy();
    // The step count reflects the prepended thinking step.
    expect(getByText2("2 steps")).toBeTruthy();
  });
});
