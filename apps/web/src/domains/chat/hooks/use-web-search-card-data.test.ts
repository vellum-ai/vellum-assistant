/**
 * Tests for `computeWebSearchCardData` — the pure projection that
 * `useWebSearchCardData` wraps. Driving the pure function avoids React
 * context plumbing and keeps the suite focused on the
 * `(toolCalls, liveWebActivity) → card props` mapping.
 */

import { describe, expect, test } from "bun:test";


import {
  computeWebSearchCardData,
  formatMs,
} from "@/domains/chat/hooks/use-web-search-card-data.js";
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

// ---------------------------------------------------------------------------
// Empty / non-web cases
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — null cases", () => {
  test("returns null when toolCalls is empty", () => {
    expect(computeWebSearchCardData([], {})).toBeNull();
  });

  test("returns null when no tool call is a web tool", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "bash" }),
      makeToolCall({ id: "tc-2", toolName: "edit_file" }),
    ];
    expect(computeWebSearchCardData(toolCalls, {})).toBeNull();
  });

  test("returns null for OpenAI web_search_call (different tool name, no metadata)", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search_call" }),
    ];
    expect(computeWebSearchCardData(toolCalls, {})).toBeNull();
  });

  // Historical reopens (completed web tool, no metadata anywhere) used to
  // return null and fall back to the legacy card. The new behaviour keeps
  // the new card chrome rendered so the visual language stays consistent —
  // see the "historical reopen" coverage in the completed-state suite below.

  test("returns null for a mixed group (web_search + bash) so legacy card renders every call", () => {
    // `TranscriptMessageBody` groups consecutive tool calls into one card.
    // If we short-circuit to the web-search card here, the bash tool call
    // gets silently dropped from the UI because the projection only iterates
    // web tools. Bail to the legacy card.
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
      }),
    ];
    expect(computeWebSearchCardData(toolCalls, {})).toBeNull();
  });

  test("returns null when a web tool call has pendingConfirmation (legacy card threads approve/deny)", () => {
    // Strict-mode permission prompts surface approve/deny buttons through
    // `ToolCallProgressCard`'s `pendingConfirmationToolCallId` plumbing — the
    // web-search card path doesn't render that UI. Bail so the user isn't
    // stuck on "Searching..." indefinitely.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
        input: { query: "tigers" },
        pendingConfirmation: { requestId: "req-1" },
      }),
    ];
    expect(computeWebSearchCardData(toolCalls, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Completed entries
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — completed entries", () => {
  test("emits two web_search step descriptors in toolCall order", () => {
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
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data).not.toBeNull();
    expect(data!.steps).toHaveLength(2);
    expect(data!.steps[0]).toMatchObject({
      kind: "web_search",
      title: "Searched the web",
      durationLabel: "1s",
      linkCount: 2,
    });
    expect((data!.steps[0] as { results: WebSearchResultItem[] }).results).toHaveLength(2);
    expect(data!.steps[1]).toMatchObject({
      kind: "web_search",
      title: "Searched the web",
      durationLabel: "3s",
      linkCount: 3,
    });
    expect((data!.steps[1] as { results: WebSearchResultItem[] }).results).toHaveLength(3);
    expect(data!.currentStepTitle).toBe("Searched the web");
    expect(data!.stepCount).toBe("2 steps");
  });

  test("emits a thinking step for webFetch with `Reading <title>` text", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_fetch" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webFetch: {
          url: "https://nytimes.com/article",
          finalUrl: "https://nytimes.com/article",
          status: 200,
          byteCount: 1000,
          charCount: 800,
          truncated: false,
          title: "Breaking news",
          domain: "nytimes.com",
          redirectCount: 0,
          durationMs: 500,
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data).not.toBeNull();
    expect(data!.steps).toHaveLength(1);
    expect(data!.steps[0]).toEqual({
      kind: "thinking",
      durationLabel: "<1s",
      text: "Reading Breaking news",
    });
  });

  test("falls back to domain when webFetch has no title", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_fetch" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webFetch: {
          url: "https://nytimes.com/article",
          finalUrl: "https://nytimes.com/article",
          status: 200,
          byteCount: 1000,
          charCount: 800,
          truncated: false,
          domain: "nytimes.com",
          redirectCount: 0,
          durationMs: 1500,
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect((data!.steps[0] as { text: string }).text).toBe(
      "Reading nytimes.com",
    );
  });

  test("truncates results above MAX_VISIBLE and sets overflow", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search" }),
    ];
    const results = Array.from({ length: 8 }, (_, i) => makeResult(i + 1));
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "q",
          provider: "anthropic-native",
          resultCount: 8,
          durationMs: 2000,
          results,
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    const step = data!.steps[0] as {
      results: WebSearchResultItem[];
      overflow?: number;
    };
    expect(step.results).toHaveLength(5);
    expect(step.overflow).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// In-flight placeholder
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — in-flight tool calls", () => {
  test("emits a `Searching...` placeholder when metadata is missing", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
        input: { query: "tigers" },
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect(data).not.toBeNull();
    expect(data!.steps).toHaveLength(1);
    expect(data!.steps[0]).toEqual({
      kind: "thinking",
      durationLabel: "",
      text: "Searching...",
    });
    expect(data!.currentStepTitle).toBe("Searching the web");
    // In-flight with no metadata yet → header reads `Searching <query>`
    // using the tool-call input so the carousel surfaces immediate context
    // while the daemon stamps `activityMetadata`.
    expect(data!.currentStepInfo).toBe("Searching tigers");
  });

  test("interleaves completed metadata with an in-flight placeholder", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search" }),
      makeToolCall({
        id: "tc-2",
        toolName: "web_search",
        status: "running",
        input: { query: "next-query" },
      }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "first",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 800,
          results: [makeResult(1)],
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.steps).toHaveLength(2);
    expect(data!.steps[0]!.kind).toBe("web_search");
    // The first (completed) row reads past-tense even though the overall
    // turn is still in-flight — per-row tense reflects the individual
    // tool call's terminality, not the card's `state`.
    expect((data!.steps[0] as { title: string }).title).toBe(
      "Searched the web",
    );
    expect(data!.steps[1]).toEqual({
      kind: "thinking",
      durationLabel: "",
      text: "Searching...",
    });
    expect(data!.currentStepTitle).toBe("Searching the web");
  });
});

// ---------------------------------------------------------------------------
// Step-row tense (Change 4)
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — web_search row tense", () => {
  test("emits 'Searched the web' on a completed tool call", () => {
    const toolCalls = [makeToolCall({ id: "tc-1", toolName: "web_search" })];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "q",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 500,
          results: [makeResult(1)],
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect((data!.steps[0] as { title: string }).title).toBe(
      "Searched the web",
    );
  });

  test("emits 'Searching the web' on a still-running tool call with live metadata", () => {
    // Anthropic emits partial metadata mid-stream — once results arrive we
    // still want the row label to read present-tense until the call itself
    // finalises.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
      }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "q",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 500,
          results: [makeResult(1)],
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect((data!.steps[0] as { title: string }).title).toBe(
      "Searching the web",
    );
  });
});

// ---------------------------------------------------------------------------
// Result-text fallback (Change 3)
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — result-text fallback", () => {
  test("parses an Anthropic-native dump in tc.result when no metadata is present", () => {
    // Page-reload case: the daemon doesn't persist `activityMetadata` per
    // v1 scope, but the legacy `result: string` survives. The selector
    // parses it so the row renders favicon chips rather than '0 links'.
    const tcResult = [
      "Tigers - Wikipedia",
      "https://en.wikipedia.org/wiki/Tiger",
      "",
      "Big Cats Conservation",
      "https://bigcats.org/conservation",
    ].join("\n");
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "completed",
        result: tcResult,
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect(data!.steps).toHaveLength(1);
    const step = data!.steps[0] as {
      kind: string;
      title: string;
      linkCount: number;
      results: WebSearchResultItem[];
    };
    expect(step.kind).toBe("web_search");
    expect(step.title).toBe("Searched the web");
    expect(step.linkCount).toBe(2);
    expect(step.results).toHaveLength(2);
    expect(step.results[0]!.url).toBe("https://en.wikipedia.org/wiki/Tiger");
    expect(step.results[0]!.domain).toBe("en.wikipedia.org");
    expect(data!.currentStepInfo).toBe("Big Cats Conservation");
  });

  test("falls through to the empty row when tc.result has no URLs", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "completed",
        result: "Found 0 results",
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect((data!.steps[0] as { results: WebSearchResultItem[] }).results)
      .toHaveLength(0);
  });

  test("webFetch falls through to the empty fallback (no parser for raw page bodies)", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_fetch",
        status: "completed",
        result: "<html><body>...page content with https://random.url</body></html>",
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect(data!.steps).toHaveLength(1);
    expect(data!.steps[0]).toEqual({
      kind: "web_search",
      title: "Searched the web",
      durationLabel: "",
      linkCount: 0,
      results: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Error variant (Change 5)
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — error variant", () => {
  test("emits a web_search_error step when metadata has errorMessage and empty results", () => {
    const toolCalls = [makeToolCall({ id: "tc-1", toolName: "web_search" })];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "q",
          provider: "anthropic-native",
          resultCount: 0,
          durationMs: 1200,
          results: [],
          errorMessage: "max_uses_exceeded",
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.steps).toHaveLength(1);
    expect(data!.steps[0]).toEqual({
      kind: "web_search_error",
      title: "Web search failed",
      durationLabel: "1s",
      errorMessage: "max_uses_exceeded",
    });
  });

  test("renders results normally when errorMessage is present alongside non-empty results", () => {
    // Provider partial-failure semantics: when results came back, surface
    // them — only fall back to the error chip when the search has nothing
    // else to show.
    const toolCalls = [makeToolCall({ id: "tc-1", toolName: "web_search" })];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "q",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 500,
          results: [makeResult(1)],
          errorMessage: "partial_results",
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.steps[0]!.kind).toBe("web_search");
  });
});

// ---------------------------------------------------------------------------
// Step count
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — step count", () => {
  test("renders `1 step` (singular) when there is exactly one step", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect(data!.stepCount).toBe("1 step");
  });
});

// ---------------------------------------------------------------------------
// currentStepInfo — page-title preference
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — currentStepInfo", () => {
  test("uses the latest web_search result's page title (never a URL)", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "best italian restaurants rome",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 1200,
          results: [
            makeResult(1, {
              title: "Best Italian Restaurants in Rome",
              url: "https://tripadvisor.it/Restaurants-g187791-Rome_Lazio.html",
            }),
          ],
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.currentStepInfo).toBe("Best Italian Restaurants in Rome");
  });

  test("uses the LAST result of the most recent step (most-recently surfaced)", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "q",
          provider: "anthropic-native",
          resultCount: 3,
          durationMs: 1000,
          results: [
            makeResult(1, { title: "First" }),
            makeResult(2, { title: "Second" }),
            makeResult(3, { title: "Third" }),
          ],
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.currentStepInfo).toBe("Third");
  });

  test("falls back to webFetch title when only a fetch ran", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_fetch" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webFetch: {
          url: "https://nytimes.com/article",
          finalUrl: "https://nytimes.com/article",
          status: 200,
          byteCount: 0,
          charCount: 0,
          truncated: false,
          title: "Breaking news today",
          domain: "nytimes.com",
          redirectCount: 0,
          durationMs: 500,
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.currentStepInfo).toBe("Breaking news today");
  });

  test("falls back to webFetch domain when no fetch title is set", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_fetch" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webFetch: {
          url: "https://nytimes.com/article",
          finalUrl: "https://nytimes.com/article",
          status: 200,
          byteCount: 0,
          charCount: 0,
          truncated: false,
          domain: "nytimes.com",
          redirectCount: 0,
          durationMs: 500,
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.currentStepInfo).toBe("nytimes.com");
  });

  test("returns `Searching <query>` for in-flight web_search with input query but no metadata", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
        input: { query: "tigers" },
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect(data!.currentStepInfo).toBe("Searching tigers");
  });

  test("returns empty string when an in-flight web_search has neither metadata nor an input query", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect(data!.currentStepInfo).toBe("");
  });

  test("returns `Searching <query>` when metadata is present but results are still streaming", () => {
    // Anthropic emits partial metadata mid-stream: `query` arrives before
    // any `results`. The carousel header should read as a search-in-progress
    // until the first result lands.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
      }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "italian restaurants rome",
          provider: "anthropic-native",
          resultCount: 0,
          durationMs: 0,
          results: [],
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.currentStepInfo).toBe("Searching italian restaurants rome");
  });

  test("returns `Reading <domain>` for in-flight web_fetch", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_fetch",
        status: "running",
      }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webFetch: {
          url: "https://nytimes.com/article",
          finalUrl: "https://nytimes.com/article",
          status: 200,
          byteCount: 0,
          charCount: 0,
          truncated: false,
          domain: "nytimes.com",
          redirectCount: 0,
          durationMs: 0,
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.currentStepInfo).toBe("Reading nytimes.com");
  });

  test("returns `Reading <host>` for in-flight web_fetch with no metadata yet", () => {
    // Best-effort host extraction from the tool-call input so the header
    // is useful before the daemon's metadata round-trips.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_fetch",
        status: "running",
        input: { url: "https://example.com/some/path" },
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect(data!.currentStepInfo).toBe("Reading example.com");
  });

  test("returns the error message for web_search_error", () => {
    const toolCalls = [makeToolCall({ id: "tc-1", toolName: "web_search" })];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "q",
          provider: "anthropic-native",
          resultCount: 0,
          durationMs: 800,
          results: [],
          errorMessage: "Provider quota exceeded",
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.currentStepInfo).toBe("Provider quota exceeded");
  });

  test("derives from the LATEST tool call when multiple are present", () => {
    // The carousel reflects the *most recent* step in the assembled array.
    // Earlier completed steps aren't surfaced once a later one starts.
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search" }),
      makeToolCall({
        id: "tc-2",
        toolName: "web_fetch",
        status: "running",
      }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "old",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 500,
          results: [makeResult(1, { title: "Stale result" })],
        },
      },
      "tc-2": {
        webFetch: {
          url: "https://example.com",
          finalUrl: "https://example.com",
          status: 200,
          byteCount: 0,
          charCount: 0,
          truncated: false,
          domain: "example.com",
          redirectCount: 0,
          durationMs: 0,
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.currentStepInfo).toBe("Reading example.com");
  });
});

// ---------------------------------------------------------------------------
// currentStepTitle — per-step tense reflects the latest step
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — currentStepTitle", () => {
  test("reflects the latest web_search tool call's per-row tense", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search" }),
      makeToolCall({
        id: "tc-2",
        toolName: "web_search",
        status: "running",
      }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "first",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 500,
          results: [makeResult(1)],
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    // Latest tool call is still running → header reads present-tense even
    // though the earlier step finished.
    expect(data!.currentStepTitle).toBe("Searching the web");
  });

  test("reads `Thinking` when the latest step is a web_fetch", () => {
    // web_fetch tool calls render under a generic "Thinking" row in the
    // expanded body, so the collapsed header carousel should match.
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_fetch" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webFetch: {
          url: "https://nytimes.com",
          finalUrl: "https://nytimes.com",
          status: 200,
          byteCount: 0,
          charCount: 0,
          truncated: false,
          title: "Breaking news",
          domain: "nytimes.com",
          redirectCount: 0,
          durationMs: 500,
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.currentStepTitle).toBe("Thinking");
  });

  test("reads `Web search failed` when the latest step is a web_search_error", () => {
    const toolCalls = [makeToolCall({ id: "tc-1", toolName: "web_search" })];
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
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.currentStepTitle).toBe("Web search failed");
  });
});

// ---------------------------------------------------------------------------
// state field — loading vs complete
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — state", () => {
  test("state is `loading` while at least one web tool is running", () => {
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "running",
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect(data!.state).toBe("loading");
    expect(data!.currentStepTitle).toBe("Searching the web");
  });

  test("state is `loading` for a mix of in-flight and completed web tools", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search" }),
      makeToolCall({
        id: "tc-2",
        toolName: "web_search",
        status: "running",
        input: { query: "still running" },
      }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "done",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 800,
          results: [makeResult(1)],
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.state).toBe("loading");
    expect(data!.currentStepTitle).toBe("Searching the web");
  });

  test("state is `complete` once every web tool has reached a terminal status", () => {
    const toolCalls = [
      makeToolCall({ id: "tc-1", toolName: "web_search" }),
      makeToolCall({ id: "tc-2", toolName: "web_search" }),
    ];
    const liveWebActivity: Record<string, ToolActivityMetadata> = {
      "tc-1": {
        webSearch: {
          query: "a",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 700,
          results: [makeResult(1)],
        },
      },
      "tc-2": {
        webSearch: {
          query: "b",
          provider: "anthropic-native",
          resultCount: 1,
          durationMs: 900,
          results: [makeResult(2)],
        },
      },
    };
    const data = computeWebSearchCardData(toolCalls, liveWebActivity);
    expect(data!.state).toBe("complete");
    expect(data!.currentStepTitle).toBe("Searched the web");
    expect(data!.stepCount).toBe("2 steps");
  });

  test("reads persisted `tc.activityMetadata` after MESSAGE_COMPLETE clears liveWebActivity", () => {
    // Once the turn idles the reducer wipes `liveWebActivity`. The selector
    // falls back to `tc.activityMetadata` (set by `applyToolResult`) so the
    // new card stays rendered with full results rather than collapsing to
    // the legacy card.
    const persistedMetadata: ToolActivityMetadata = {
      webSearch: {
        query: "tigers",
        provider: "anthropic-native",
        resultCount: 1,
        durationMs: 1200,
        results: [makeResult(1)],
      },
    };
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "completed",
        activityMetadata: persistedMetadata,
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect(data).not.toBeNull();
    expect(data!.state).toBe("complete");
    expect(data!.currentStepTitle).toBe("Searched the web");
    expect(data!.steps[0]).toMatchObject({
      kind: "web_search",
      title: "Searched the web",
      linkCount: 1,
    });
    expect(
      (data!.steps[0] as { results: WebSearchResultItem[] }).results,
    ).toHaveLength(1);
  });

  test("historical reopen (terminal tool, no metadata anywhere) still renders the new card", () => {
    // Server-hydrated messages don't include `activityMetadata` — the
    // selector emits an empty `web_search` step so the new card chrome
    // remains rather than falling back to the legacy card.
    const toolCalls = [
      makeToolCall({
        id: "tc-1",
        toolName: "web_search",
        status: "completed",
        result: "Found 3 results",
      }),
    ];
    const data = computeWebSearchCardData(toolCalls, {});
    expect(data).not.toBeNull();
    expect(data!.state).toBe("complete");
    expect(data!.currentStepTitle).toBe("Searched the web");
    expect(data!.steps).toHaveLength(1);
    expect(data!.steps[0]).toEqual({
      kind: "web_search",
      title: "Searched the web",
      durationLabel: "",
      linkCount: 0,
      results: [],
    });
  });
});

// ---------------------------------------------------------------------------
// carouselItems
// ---------------------------------------------------------------------------

describe("computeWebSearchCardData — carouselItems", () => {
  test("is empty when no web_search has completed", () => {
    const tc = makeToolCall({
      id: "tc1",
      toolName: "web_search",
      status: "running",
      input: { query: "foo" },
    });
    const result = computeWebSearchCardData([tc], {});
    expect(result?.carouselItems).toEqual([]);
  });

  test("feeds from the most recent completed web_search's results", () => {
    const olderResults = [makeResult(1, { title: "Old A" })];
    const newerResults = [
      makeResult(1, { title: "New A" }),
      makeResult(2, { title: "New B" }),
    ];
    const tc1 = makeToolCall({ id: "tc1", toolName: "web_search" });
    const tc2 = makeToolCall({ id: "tc2", toolName: "web_search" });
    const live: Record<string, ToolActivityMetadata> = {
      tc1: { webSearch: { query: "old", provider: "anthropic-native", resultCount: 1, durationMs: 100, results: olderResults } },
      tc2: { webSearch: { query: "new", provider: "anthropic-native", resultCount: 2, durationMs: 100, results: newerResults } },
    };
    const result = computeWebSearchCardData([tc1, tc2], live);
    // Most recent (`tc2`) wins; earlier search is not concatenated.
    expect(result?.carouselItems).toEqual(newerResults);
  });

  test("skips an in-flight latest call to use the previous completed search's results", () => {
    const completedResults = [makeResult(1, { title: "Old A" })];
    const tc1 = makeToolCall({ id: "tc1", toolName: "web_search" });
    const tc2 = makeToolCall({
      id: "tc2",
      toolName: "web_search",
      status: "running",
      input: { query: "next" },
    });
    const live: Record<string, ToolActivityMetadata> = {
      tc1: { webSearch: { query: "old", provider: "anthropic-native", resultCount: 1, durationMs: 100, results: completedResults } },
    };
    const result = computeWebSearchCardData([tc1, tc2], live);
    expect(result?.carouselItems).toEqual(completedResults);
  });

  test("skips error-state searches (errorMessage + empty results)", () => {
    const tc = makeToolCall({ id: "tc1", toolName: "web_search", status: "error" });
    const live: Record<string, ToolActivityMetadata> = {
      tc1: {
        webSearch: {
          query: "bad",
          provider: "anthropic-native",
          resultCount: 0,
          durationMs: 100,
          results: [],
          errorMessage: "rate limited",
        },
      },
    };
    const result = computeWebSearchCardData([tc], live);
    expect(result?.carouselItems).toEqual([]);
  });

  test("does not include web_fetch results in the carousel", () => {
    const tc = makeToolCall({ id: "tc1", toolName: "web_fetch" });
    const live: Record<string, ToolActivityMetadata> = {
      tc1: {
        webFetch: {
          url: "https://x.test",
          finalUrl: "https://x.test",
          status: 200,
          byteCount: 1,
          charCount: 1,
          truncated: false,
          domain: "x.test",
          redirectCount: 0,
          durationMs: 100,
          title: "X",
        },
      },
    };
    const result = computeWebSearchCardData([tc], live);
    expect(result?.carouselItems).toEqual([]);
  });

  test("reads persisted tc.activityMetadata when liveWebActivity is empty", () => {
    const results = [makeResult(1, { title: "Persisted A" })];
    const tc = makeToolCall({
      id: "tc1",
      toolName: "web_search",
      activityMetadata: {
        webSearch: { query: "x", provider: "anthropic-native", resultCount: 1, durationMs: 100, results },
      },
    });
    const result = computeWebSearchCardData([tc], {});
    expect(result?.carouselItems).toEqual(results);
  });
});

// ---------------------------------------------------------------------------
// formatMs
// ---------------------------------------------------------------------------

describe("formatMs", () => {
  test("returns <1s for sub-second durations", () => {
    expect(formatMs(0)).toBe("<1s");
    expect(formatMs(999)).toBe("<1s");
  });

  test("rounds to nearest second for >= 1000ms", () => {
    expect(formatMs(1000)).toBe("1s");
    expect(formatMs(1499)).toBe("1s");
    expect(formatMs(1500)).toBe("2s");
    expect(formatMs(2500)).toBe("3s");
  });
});
