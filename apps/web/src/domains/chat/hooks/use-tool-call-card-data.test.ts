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
  computeToolCallCardData,
  hasWebTool,
} from "@/domains/chat/hooks/use-tool-call-card-data.js";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types.js";
import type {
  ToolActivityMetadata,
  WebSearchResultItem,
} from "@/assistant/web-activity-types.js";

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
    toolName: string;
  },
): ChatMessageToolCall {
  return {
    input: {},
    status: "completed",
    ...overrides,
  };
}

describe("computeToolCallCardData — step kinds", () => {
  test("emits a `tool` step for a non-web tool via deriveStepLabel", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        startedAt: 1000,
        completedAt: 2500,
        input: { command: "echo hello" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]).toEqual({
      kind: "tool",
      durationLabel: "2s",
      title: "Working (bash)",
      info: "echo hello",
      iconName: "code",
      toolCallId: "tc-1",
      status: "completed",
    });
    expect(data.state).toBe("complete");
    // `currentStepTitle` / `currentStepInfo` mirror the tool step.
    expect(data.currentStepTitle).toBe("Working (bash)");
    expect(data.currentStepInfo).toBe("echo hello");
  });

  test("emits a `web_search` step with the legacy descriptor shape", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search", status: "completed" }),
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
    const data = computeToolCallCardData(toolCalls, liveWebActivity, null);
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
      makeToolCall({ id: "tc-1", toolName: "web_search", status: "completed" }),
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
    const data = computeToolCallCardData(toolCalls, liveWebActivity, null);
    expect(data.steps[0]).toEqual({
      kind: "web_search_error",
      title: "Web search failed",
      durationLabel: "<1s",
      errorMessage: "max_uses_exceeded",
    });
  });

  test("emits a `thinking` step for web_fetch metadata", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_fetch", status: "completed" }),
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
    const data = computeToolCallCardData(toolCalls, liveWebActivity, null);
    expect(data.steps[0]).toEqual({
      kind: "thinking",
      durationLabel: "<1s",
      text: "Reading Breaking news",
    });
  });
});

describe("computeToolCallCardData — leadingThinkingText", () => {
  test("prepends a `thinking` step when leadingThinkingText is non-null", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        startedAt: 0,
        completedAt: 1000,
      }),
    ];
    const data = computeToolCallCardData(
      toolCalls,
      {},
      "I'll look at the bash output first.",
    );
    expect(data.steps).toHaveLength(2);
    expect(data.steps[0]).toEqual({
      kind: "thinking",
      durationLabel: "",
      text: "I'll look at the bash output first.",
    });
    expect(data.steps[1]!.kind).toBe("tool");
    expect(data.stepCount).toBe("2 steps");
  });

  test("does not prepend when leadingThinkingText is null", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "bash", status: "completed" }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]!.kind).toBe("tool");
  });

  test("does not prepend when leadingThinkingText is empty", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "bash", status: "completed" }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, "");
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]!.kind).toBe("tool");
  });
});

describe("computeToolCallCardData — state transitions", () => {
  test("state is `loading` while any tool call is still running", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "bash", status: "running" }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.state).toBe("loading");
  });

  test("state is `loading` for a mix of running + completed tools", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "bash", status: "completed" }),
      makeToolCall({ id: "tc-2", toolName: "edit_file", status: "running" }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.state).toBe("loading");
  });

  test("state is `complete` once every tool reaches a terminal status", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "bash", status: "completed" }),
      makeToolCall({
        id: "tc-2",
        toolName: "str_replace_editor",
        status: "completed",
        input: { command: "view", path: "/tmp/x.txt" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.state).toBe("complete");
    expect(data.stepCount).toBe("2 steps");
  });

  test("state is `denied` when any tool has confirmationDecision === 'denied'", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "completed",
        confirmationDecision: "denied",
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.state).toBe("denied");
    expect((data.steps[0] as { status: string }).status).toBe("denied");
  });

  test("state is `denied` even when another tool is still running (precedence)", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "bash",
        status: "running",
        confirmationDecision: "denied",
      }),
      makeToolCall({ id: "tc-2", toolName: "edit_file", status: "running" }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.state).toBe("denied");
  });

  test("state is `error` when a tool ended in error and no tools are still running", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "bash", status: "error" }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.state).toBe("error");
    expect((data.steps[0] as { status: string }).status).toBe("error");
  });

  test("state is `loading` (not `error`) when an error tool sits alongside a still-running tool", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "bash", status: "error" }),
      makeToolCall({ id: "tc-2", toolName: "edit_file", status: "running" }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.state).toBe("loading");
  });
});

describe("computeToolCallCardData — subagent_spawn filtering", () => {
  test("a subagent_spawn-only group produces zero steps", () => {
    // Inline `SubagentInlineProgressCard` renders the spawned subagent
    // at the transcript level — surfacing a step inside the unified card
    // would render the spawn twice.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "subagent_spawn",
        status: "running",
        input: { label: "Investigate logs" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
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
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.steps).toHaveLength(0);
  });

  test("mixed group keeps non-subagent_spawn steps and drops the spawn", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "subagent_spawn",
        status: "running",
        input: { label: "Investigate" },
      }),
      makeToolCall({
        id: "tc-2",
        toolName: "bash",
        status: "running",
        input: { command: "ls" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0]!.kind).toBe("tool");
    // Header derivation also ignores the filtered spawn so the carousel
    // reflects only the bash call.
    expect(data.currentStepTitle).toBe("Working (bash)");
  });
});

describe("computeToolCallCardData — regression vs. legacy web-search hook", () => {
  // Same fixture as the legacy hook's "emits two web_search step descriptors
  // in toolCall order" case — checking that the unified path produces the
  // same step set + state for purely-web inputs.
  test("matches the legacy hook's output for the 'two completed web_search' fixture", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search" }),
      makeToolCall({ id: "tc-2", toolName: "web_search" }),
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
    const data = computeToolCallCardData(toolCalls, liveWebActivity, null);
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

  test("emits the same `Searching...` placeholder for an in-flight web tool with no metadata", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
        input: { query: "tigers" },
      }),
    ];
    const data = computeToolCallCardData(toolCalls, {}, null);
    expect(data.steps[0]).toEqual({
      kind: "thinking",
      durationLabel: "",
      text: "Searching...",
    });
    expect(data.state).toBe("loading");
    expect(data.currentStepTitle).toBe("Searching the web");
    expect(data.currentStepInfo).toBe("Searching tigers");
  });
});

describe("computeToolCallCardData — mixed web + non-web groups", () => {
  test("emits a `tool` step alongside a `web_search` step in declared order", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "completed",
      }),
      makeToolCall({
        id: "tc-2",
        toolName: "bash",
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
    const data = computeToolCallCardData(toolCalls, liveWebActivity, null);
    expect(data.steps).toHaveLength(2);
    expect(data.steps[0]!.kind).toBe("web_search");
    expect(data.steps[1]!.kind).toBe("tool");
    // currentStepTitle reflects the latest call (the bash tool).
    expect(data.currentStepTitle).toBe("Working (bash)");
    expect(data.currentStepInfo).toBe("ls");
  });
});

describe("hasWebTool", () => {
  test("returns true when any tool call is a web tool", () => {
    expect(
      hasWebTool([
        makeToolCall({ id: "tc-1", toolName: "bash" }),
        makeToolCall({ id: "tc-2", toolName: "web_search" }),
      ]),
    ).toBe(true);
  });

  test("returns false when no tool calls are web tools", () => {
    expect(
      hasWebTool([makeToolCall({ id: "tc-1", toolName: "bash" })]),
    ).toBe(false);
  });

  test("returns false on an empty list", () => {
    expect(hasWebTool([])).toBe(false);
  });
});
