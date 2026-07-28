/**
 * Tests for `computeToolCallCardData` — the pure projection that
 * `useToolCallCardData` wraps.
 *
 * Covered behaviours:
 *   - One case per `ToolCallCardStep` kind (`thinking` /
 *     `web_search` / `web_search_error` / `tool`).
 *   - Leading-thinking text prepending.
 *   - Card-level `state` transitions (loading → complete, mixed
 *     running+completed, denied present, error present).
 *   - Header `currentStepTitle` / `currentStepInfo` for non-web tools.
 *   - Backward-compatibility: the historical web-search fixtures still feed
 *     through the unified path and produce the same step + state outputs as
 *     the previous web-only hook (regression-checked via the dedicated
 *     "regression vs. legacy web-search hook" suite below).
 */

import { describe, expect, test } from "bun:test";

import {
  buildWebSearchErrorStep,
  computeToolCallCardData,
  computeToolCallCardDataFromItems,
  type ToolCallCardItem,
  WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
} from "@/domains/chat/utils/tool-call-card-utils";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { toolCallStatusWireFields } from "@/domains/chat/utils/message-test-helpers";
import type {
  ToolActivityMetadata,
  WebSearchResultItem,
} from "@/assistant/web-activity-types";

function makeResult(
  i: number,
  overrides: Partial<WebSearchResultItem> = {},
): WebSearchResultItem {
  return {
    rank: i,
    title: `Result ${i}`,
    url: `https://example-${i}.test/article`,
    domain: `example-${i}.test`,
    faviconUrl: `https://example-${i}.test/favicon.ico`,
    ...overrides,
  };
}

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

describe("computeToolCallCardData — step kinds", () => {
  test("emits a `tool` step for a non-web tool via deriveStepLabel", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        startedAt: 1000,
        completedAt: 2500,
        input: { command: "echo hello" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]).toEqual({
      kind: "tool",
      durationLabel: "2s",
      startedAt: 1000,
      title: "Working",
      info: "echo hello",
      activity: "",
      riskLevel: undefined,
      iconName: "terminal",
      toolCallId: "tc-1",
      status: "completed",
    });
    expect(data.state).toBe("complete");
    // The collapsed header shows the tool's "Working" title verbatim,
    // paired with the command in the info slot, so a collapsed card
    // carousels the live step ("Working | echo hello").
    expect(data.currentStepTitle).toBe("Working");
    expect(data.currentStepInfo).toBe("echo hello");
  });

  test("carries activity + riskLevel on the `tool` step and prefers activity for currentStepInfo", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        riskLevel: "low",
        input: {
          command: "echo hello",
          activity: "Greeting the user from the shell",
        },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.steps[0]).toMatchObject({
      kind: "tool",
      activity: "Greeting the user from the shell",
      riskLevel: "low",
    });
    // Collapsed-header subtext prefers the rich activity sentence.
    expect(data.currentStepInfo).toBe("Greeting the user from the shell");
  });

  test("falls back to terse info for currentStepInfo when no activity is present", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        input: { command: "echo hello" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.steps[0]).toMatchObject({ kind: "tool", activity: "" });
    expect(data.currentStepInfo).toBe("echo hello");
  });

  test("emits a `web_search` step with the legacy descriptor shape", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "web_search", status: "completed" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "tigers",
          provider: "anthropic-native",
          resultCount: 2,
          durationMs: 1500,
          results: [makeResult(1), makeResult(2)],
        },
      },
    };
    const data = computeToolCallCardData(toolCalls, liveWebActivity);
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]).toMatchObject({
      kind: "web_search",
      title: "Searched the web",
      durationLabel: "2s",
      linkCount: 2,
    });
  });

  test("emits a `web_search_error` step when metadata has errorMessage and empty results", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "web_search", status: "completed" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "q",
          provider: "anthropic-native",
          resultCount: 0,
          durationMs: 800,
          results: [],
          errorMessage: "max_uses_exceeded",
        },
      },
    };
    const data = computeToolCallCardData(toolCalls, liveWebActivity);
    expect(data.steps[0]).toEqual({
      kind: "web_search_error",
      title: "Web search failed",
      durationLabel: "<1s",
      errorMessage: "max_uses_exceeded",
    });
  });

  test("emits a `thinking` step for web_fetch metadata", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "web_fetch", status: "completed" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webFetch: {
          url: "https://nytimes.com/article",
          finalUrl: "https://nytimes.com/article",
          status: 200,
          byteCount: 1,
          charCount: 1,
          truncated: false,
          title: "Breaking news",
          domain: "nytimes.com",
          redirectCount: 0,
          durationMs: 500,
        },
      },
    };
    const data = computeToolCallCardData(toolCalls, liveWebActivity);
    expect(data.steps[0]).toEqual({
      kind: "thinking",
      durationLabel: "<1s",
      text: "Reading Breaking news",
    });
  });
});

describe("computeToolCallCardData — state transitions", () => {
  test("state is `loading` while any tool call is still running", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "bash", status: "running" }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.state).toBe("loading");
  });

  test("state is `loading` for a mix of running + completed tools", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "bash", status: "completed" }),
      makeToolCall({ id: "tc-2", name: "edit_file", status: "running" }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.state).toBe("loading");
  });

  test("state is `complete` once every tool reaches a terminal status", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "bash", status: "completed" }),
      makeToolCall({
        id: "tc-2",
        name: "str_replace_editor",
        status: "completed",
        input: { command: "view", path: "/tmp/x.txt" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.state).toBe("complete");
    expect(data.stepCount).toBe("2 steps");
  });

  test("state is `denied` when any tool has confirmationDecision === 'denied'", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "completed",
        confirmationDecision: "denied",
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.state).toBe("denied");
    expect((data.steps[0] as { status: string }).status).toBe("denied");
  });

  test("state is `denied` even when another tool is still running (precedence)", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "bash",
        status: "running",
        confirmationDecision: "denied",
      }),
      makeToolCall({ id: "tc-2", name: "edit_file", status: "running" }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.state).toBe("denied");
  });

  test("state is `error` when a tool ended in error and no tools are still running", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "bash", status: "error" }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.state).toBe("error");
    expect((data.steps[0] as { status: string }).status).toBe("error");
  });

  test("state is `loading` (not `error`) when an error tool sits alongside a still-running tool", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "bash", status: "error" }),
      makeToolCall({ id: "tc-2", name: "edit_file", status: "running" }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.state).toBe("loading");
  });
});

describe("computeToolCallCardData — subagent_spawn filtering", () => {
  test("a subagent_spawn-only group produces zero steps", () => {
    // The subagent descriptor's `InlineProcessCard` renders the spawned
    // subagent at the transcript level — surfacing a step inside the unified
    // card would render the spawn twice.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "subagent_spawn",
        status: "running",
        input: { label: "Investigate logs" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.steps).toHaveLength(0);
    expect(data.stepCount).toBe("0 steps");
  });

  test("multiple subagent_spawn calls in one group still produce zero steps", () => {
    // Multi-spawn used to slip past the dispatcher's `length === 1` guard
    // and render "Spawning subagent" rows inside the unified card alongside
    // the inline cards — a double render.
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
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.steps).toHaveLength(0);
  });

  test("mixed group keeps non-subagent_spawn steps and drops the spawn", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "subagent_spawn",
        status: "running",
        input: { label: "Investigate" },
      }),
      makeToolCall({
        id: "tc-2",
        name: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]!.kind).toBe("tool");
    // Header derivation also ignores the filtered spawn so the carousel
    // reflects only the bash call — whose "Working" title now shows verbatim.
    expect(data.currentStepTitle).toBe("Working");
  });
});

describe("computeToolCallCardDataFromItems — interleaved ordering", () => {
  test("interleaves thinking between tool steps in the given order", () => {
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: "first I reason" },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-1",
          name: "bash",
          status: "completed",
          input: { command: "ls" },
        }),
      },
      { kind: "thinking", text: "then I reason again" },
    ];
    const data = computeToolCallCardDataFromItems(items, {});
    expect(data.steps).toHaveLength(3);
    expect(data.steps[0]).toEqual({
      kind: "thinking",
      durationLabel: "",
      text: "first I reason",
      startedAt: undefined,
      completedAt: undefined,
      thinkingItemIndex: 0,
    });
    expect(data.steps[1]!.kind).toBe("tool");
    expect(data.steps[2]).toEqual({
      kind: "thinking",
      durationLabel: "",
      text: "then I reason again",
      startedAt: undefined,
      completedAt: undefined,
      thinkingItemIndex: 1,
    });
    expect(data.stepCount).toBe("3 steps");
  });

  test("derives a thinking step's duration label from its timestamps", () => {
    /**
     * A thinking step carrying start/completion timestamps should surface the
     * same `formatMs` duration label as a tool step, so the phase renders "3s"
     * and a "Started at …" hover.
     */

    // GIVEN a thinking item that spans 3 seconds and one with no timestamps
    const items: ToolCallCardItem[] = [
      {
        kind: "thinking",
        text: "stamped reasoning",
        startedAt: 1_000,
        completedAt: 4_000,
      },
      { kind: "thinking", text: "unstamped reasoning" },
    ];

    // WHEN the card data is computed
    const data = computeToolCallCardDataFromItems(items, {});

    // THEN the stamped step carries the formatted duration plus its bounds
    expect(data.steps[0]).toEqual({
      kind: "thinking",
      durationLabel: "3s",
      text: "stamped reasoning",
      startedAt: 1_000,
      completedAt: 4_000,
      thinkingItemIndex: 0,
    });
    // AND the unstamped step hides its duration, exactly as a tool with no timing
    expect(data.steps[1]).toEqual({
      kind: "thinking",
      durationLabel: "",
      text: "unstamped reasoning",
      startedAt: undefined,
      completedAt: undefined,
      thinkingItemIndex: 1,
    });
  });

  test("skips empty thinking items and subagent_spawn tool items", () => {
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: "" },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-spawn",
          name: "subagent_spawn",
          status: "running",
          input: { label: "Investigate" },
        }),
      },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-2",
          name: "bash",
          status: "running",
          input: { command: "ls" },
        }),
      },
    ];
    const data = computeToolCallCardDataFromItems(items, {});
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]!.kind).toBe("tool");
  });
});

describe("computeToolCallCardDataFromItems — totalDurationLabel", () => {
  test("sums BOTH thinking and tool time, not just tool calls", () => {
    // GIVEN a run with 2s of thinking and 3s of tool work
    const items: ToolCallCardItem[] = [
      {
        kind: "thinking",
        text: "reasoning",
        startedAt: 0,
        completedAt: 2_000,
      },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-1",
          name: "bash",
          status: "completed",
          startedAt: 2_000,
          completedAt: 5_000,
          input: { command: "ls" },
        }),
      },
    ];
    // WHEN the card data is computed at rest (no `nowMs`)
    const data = computeToolCallCardDataFromItems(items, {});
    // THEN the header total is 2s + 3s = 5s — thinking is no longer excluded
    expect(data.totalDurationLabel).toBe("5s");
  });

  test("excludes subagent_spawn time and returns '' when nothing is timed", () => {
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: "untimed reasoning" },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-spawn",
          name: "subagent_spawn",
          status: "completed",
          startedAt: 0,
          completedAt: 9_000,
          input: { label: "Investigate" },
        }),
      },
    ];
    const data = computeToolCallCardDataFromItems(items, {});
    expect(data.totalDurationLabel).toBe("");
  });

  test("ticks the running step's elapsed against nowMs during streaming", () => {
    // GIVEN a completed 4s tool plus a still-running tool started at t=10s
    const items: ToolCallCardItem[] = [
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-1",
          name: "bash",
          status: "completed",
          startedAt: 0,
          completedAt: 4_000,
          input: { command: "ls" },
        }),
      },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-2",
          name: "bash",
          status: "running",
          startedAt: 10_000,
          input: { command: "sleep 5" },
        }),
      },
    ];
    // WHEN the clock reads t=13s — the running tool has been live for 3s
    const data = computeToolCallCardDataFromItems(items, {}, 13_000);
    // THEN the header total ticks: 4s (done) + 3s (in flight) = 7s
    expect(data.totalDurationLabel).toBe("7s");
    expect(data.state).toBe("loading");
  });

  test("renders a long run in human-readable minutes, not raw seconds", () => {
    // A 3-minute tool call should read "3m", not "180s".
    const items: ToolCallCardItem[] = [
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-long",
          name: "bash",
          status: "completed",
          startedAt: 0,
          completedAt: 180_000,
          input: { command: "long-build" },
        }),
      },
    ];
    const data = computeToolCallCardDataFromItems(items, {});
    expect(data.totalDurationLabel).toBe("3m");
  });

  test("a running step contributes nothing without a clock (at rest)", () => {
    const items: ToolCallCardItem[] = [
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-1",
          name: "bash",
          status: "completed",
          startedAt: 0,
          completedAt: 4_000,
          input: { command: "ls" },
        }),
      },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-2",
          name: "bash",
          status: "running",
          startedAt: 10_000,
          input: { command: "sleep 5" },
        }),
      },
    ];
    // No `nowMs` → only the completed 4s counts.
    const data = computeToolCallCardDataFromItems(items, {});
    expect(data.totalDurationLabel).toBe("4s");
  });
});

describe("computeToolCallCardDataFromItems — header reflects the latest step", () => {
  test("a run ending in a thinking step surfaces it in the header", () => {
    const items: ToolCallCardItem[] = [
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-1",
          name: "read_file",
          status: "completed",
          input: { path: "/tmp/state.txt" },
        }),
      },
      { kind: "thinking", text: "Now I understand the current state." },
    ];
    const data = computeToolCallCardDataFromItems(items, {});
    // Latest step is thinking → "Thinking" title + the thinking text (the
    // brain glyph is added by the card component, not the projection).
    expect(data.currentStepKind).toBe("thinking");
    expect(data.currentStepTitle).toBe("Thinking");
    expect(data.currentStepInfo).toBe("Now I understand the current state.");
  });

  test("a run ending in a tool step keeps the tool-derived header", () => {
    const items: ToolCallCardItem[] = [
      { kind: "thinking", text: "Let me read the file first." },
      {
        kind: "toolCall",
        toolCall: makeToolCall({
          id: "tc-1",
          name: "bash",
          status: "completed",
          input: { command: "echo hi" },
        }),
      },
    ];
    const data = computeToolCallCardDataFromItems(items, {});
    expect(data.currentStepKind).toBe("tool");
    // The collapsed header carousels the live step: the "Working" title
    // paired with the command in the info slot.
    expect(data.currentStepTitle).toBe("Working");
    expect(data.currentStepInfo).toBe("echo hi");
  });
});

describe("computeToolCallCardData — regression vs. legacy web-search hook", () => {
  // Same fixture as the legacy hook's "emits two web_search step descriptors
  // in toolCall order" case — checking that the unified path produces the
  // same step set + state for purely-web inputs.
  test("matches the legacy hook's output for the 'two completed web_search' fixture", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "web_search" }),
      makeToolCall({ id: "tc-2", name: "web_search" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "first",
          provider: "anthropic-native",
          resultCount: 2,
          durationMs: 1234,
          results: [makeResult(1), makeResult(2)],
        },
      },
      "tc-2": {
        webSearch: {
          query: "second",
          provider: "anthropic-native",
          resultCount: 3,
          durationMs: 2500,
          results: [makeResult(3), makeResult(4), makeResult(5)],
        },
      },
    };
    const data = computeToolCallCardData(toolCalls, liveWebActivity);
    expect(data.steps).toHaveLength(2);
    expect(data.steps[0]).toMatchObject({
      kind: "web_search",
      title: "Searched the web",
      durationLabel: "1s",
      linkCount: 2,
    });
    expect(data.steps[1]).toMatchObject({
      kind: "web_search",
      title: "Searched the web",
      durationLabel: "3s",
      linkCount: 3,
    });
    expect(data.currentStepTitle).toBe("Searched the web");
    expect(data.state).toBe("complete");
    expect(data.stepCount).toBe("2 steps");
    expect(data.carouselItems).toHaveLength(3);
  });

  test("emits a web_search placeholder for an in-flight web tool with no metadata", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "web_search",
        status: "running",
        input: { query: "tigers" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.steps[0]).toEqual({
      kind: "web_search",
      title: "Searching the web",
      durationLabel: "",
      linkCount: 0,
      results: [],
    });
    expect(data.state).toBe("loading");
    expect(data.currentStepTitle).toBe("Searching the web");
    expect(data.currentStepInfo).toBe("Searching tigers");
  });

  test("emits a thinking placeholder for an in-flight web_fetch with no metadata", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "web_fetch",
        status: "running",
        input: { url: "https://example.com" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {});
    expect(data.steps[0]).toEqual({
      kind: "thinking",
      durationLabel: "",
      text: "Reading…",
    });
    expect(data.state).toBe("loading");
  });
});

describe("computeToolCallCardData — mixed web + non-web groups", () => {
  test("emits a `tool` step alongside a `web_search` step in declared order", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        name: "web_search",
        status: "completed",
      }),
      makeToolCall({
        id: "tc-2",
        name: "bash",
        status: "completed",
        startedAt: 0,
        completedAt: 500,
        input: { command: "ls" },
      }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "x",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 500,
          results: [makeResult(1)],
        },
      },
    };
    const data = computeToolCallCardData(toolCalls, liveWebActivity);
    expect(data.steps).toHaveLength(2);
    expect(data.steps[0]!.kind).toBe("web_search");
    expect(data.steps[1]!.kind).toBe("tool");
    // currentStepTitle reflects the latest call (the bash tool), whose
    // "Working" title now shows verbatim in the collapsed header.
    expect(data.currentStepTitle).toBe("Working");
    expect(data.currentStepInfo).toBe("ls");
  });
});

describe("computeToolCallCardData — web_search backend-failure copy", () => {
  // Mirror of WEB_SEARCH_BACKEND_FAILURE_MESSAGE in
  // assistant/src/tools/network/web-search-error.ts (and the module-local
  // constant in use-tool-call-card-data.ts). clients/web cannot import from
  // assistant/, so the canonical string is duplicated here verbatim.
  const CANONICAL_BACKEND_FAILURE_MESSAGE =
    "Search is having trouble right now. You can try again in a moment, continue without web search, or paste the relevant details here and I'll use those.";

  test("renders the canonical backend-failure message verbatim when the daemon provides it", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "web_search", status: "completed" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "tigers",
          provider: "anthropic-native",
          resultCount: 0,
          durationMs: 800,
          results: [],
          errorMessage: CANONICAL_BACKEND_FAILURE_MESSAGE,
        },
      },
    };
    const data = computeToolCallCardData(toolCalls, liveWebActivity);
    expect(data.steps[0]).toEqual({
      kind: "web_search_error",
      title: "Web search failed",
      durationLabel: "<1s",
      // Verbatim — not overridden, not truncated to "Search failed.".
      errorMessage: CANONICAL_BACKEND_FAILURE_MESSAGE,
    });
    expect(data.currentStepInfo).toBe(CANONICAL_BACKEND_FAILURE_MESSAGE);
  });

  test("the local default string matches the canonical assistant constant", () => {
    expect(WEB_SEARCH_BACKEND_FAILURE_MESSAGE).toBe(
      CANONICAL_BACKEND_FAILURE_MESSAGE,
    );
  });

  test("buildWebSearchErrorStep falls back to the friendly default when errorMessage is undefined", () => {
    // The error step renders verbatim copy from the daemon when present, but
    // must degrade to the canonical friendly message if the backend ever
    // omits it (regression for the buildWebSearchErrorStep default).
    const step = buildWebSearchErrorStep({
      query: "tigers",
      provider: "anthropic-native",
      resultCount: 0,
      durationMs: 800,
      results: [],
      // errorMessage intentionally omitted.
    });
    expect(step).toEqual({
      kind: "web_search_error",
      title: "Web search failed",
      durationLabel: "<1s",
      errorMessage: WEB_SEARCH_BACKEND_FAILURE_MESSAGE,
    });
  });

  test("web_fetch DNS/host errors never render as a web_search backend failure", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "web_fetch", status: "error" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webFetch: {
          url: "https://grimgoods.io/products",
          finalUrl: "https://grimgoods.io/products",
          status: 0,
          byteCount: 0,
          charCount: 0,
          truncated: false,
          domain: "grimgoods.io",
          redirectCount: 0,
          durationMs: 120,
          errorMessage:
            'Error: Unable to resolve host "grimgoods.io" while fetching the page',
        },
      },
    };
    const data = computeToolCallCardData(toolCalls, liveWebActivity);
    // No web_search_error step is produced from a web_fetch failure.
    expect(
      data.steps.some((step) => step.kind === "web_search_error"),
    ).toBe(false);
    // The friendly web_search backend copy is never surfaced for a fetch error.
    expect(data.currentStepInfo).not.toBe(CANONICAL_BACKEND_FAILURE_MESSAGE);
  });

  test("a failed web_search with empty results and NO errorMessage renders the friendly default via the UI path", () => {
    // Daemon omits webSearch.errorMessage but the tool call itself is terminal
    // with status "error" (mapped from the tool_result isError flag). This is
    // the production UI path Codex flagged — buildWebSearchErrorStep's friendly
    // default must be reachable, not only via the direct unit test.
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "web_search", status: "error" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "tigers",
          provider: "anthropic-native",
          resultCount: 0,
          durationMs: 800,
          results: [],
          // errorMessage intentionally omitted.
        },
      },
    };
    const data = computeToolCallCardData(toolCalls, liveWebActivity);
    expect(data.steps[0]).toEqual({
      kind: "web_search_error",
      title: "Web search failed",
      durationLabel: "<1s",
      errorMessage: CANONICAL_BACKEND_FAILURE_MESSAGE,
    });
    expect(data.currentStepTitle).toBe("Web search failed");
    expect(data.currentStepInfo).toBe(CANONICAL_BACKEND_FAILURE_MESSAGE);
  });

  test("a successful no_results web_search (status completed, no errorMessage) stays a normal step", () => {
    // ATL-727 core invariant: an empty-but-successful search must NOT render as
    // a failure. status "completed" + no errorMessage => normal web_search step.
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "web_search", status: "completed" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "tigers",
          provider: "anthropic-native",
          resultCount: 0,
          durationMs: 800,
          results: [],
          // errorMessage intentionally omitted; this is a real no_results hit.
        },
      },
    };
    const data = computeToolCallCardData(toolCalls, liveWebActivity);
    expect(
      data.steps.some((step) => step.kind === "web_search_error"),
    ).toBe(false);
    expect(data.steps[0]!.kind).toBe("web_search");
    expect(data.currentStepInfo).not.toBe(CANONICAL_BACKEND_FAILURE_MESSAGE);
  });

  test("a successful web_search with results produces no error step", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", name: "web_search", status: "completed" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "tigers",
          provider: "anthropic-native",
          resultCount: 2,
          durationMs: 1500,
          results: [makeResult(1), makeResult(2)],
        },
      },
    };
    const data = computeToolCallCardData(toolCalls, liveWebActivity);
    expect(
      data.steps.some((step) => step.kind === "web_search_error"),
    ).toBe(false);
    expect(data.steps[0]!.kind).toBe("web_search");
  });
});


