/**
 * Tests for `computeSubagentCardData` — the pure projection that
 * `useSubagentCardData` wraps. Driving the pure function avoids the
 * React + Zustand context plumbing and keeps coverage focused on the
 * `SubagentEntry → ToolCallCardData` mapping.
 */

import { describe, expect, test } from "bun:test";

import {
  applyTimelineEvent,
  buildSubagentStepDetails,
  computeSubagentCardData,
  computeSubagentSteps,
  mapToolEventToStep,
  type ToolCallCardStep,
  type ToolMeta,
} from "@/domains/chat/hooks/use-subagent-card-data";
import {
  groupStepsByPhase,
  phaseFromStep,
} from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import type {
  SubagentEntry,
  SubagentTimelineEvent,
} from "@/domains/chat/subagent-store";

const NOW = 1700000000000;

function makeEntry(
  overrides: Partial<SubagentEntry> & {
    events?: SubagentTimelineEvent[];
  } = {},
): SubagentEntry {
  return {
    subagentId: "sa-1",
    label: "Research Agent",
    objective: "Find the root cause",
    status: "running",
    isFork: false,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    spawnedAt: NOW,
    events: [],
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<SubagentTimelineEvent> & {
    type: SubagentTimelineEvent["type"];
  },
  i: number = 0,
): SubagentTimelineEvent {
  return {
    id: `te-${i}`,
    content: "",
    timestamp: NOW + i * 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

describe("computeSubagentCardData — state derivation", () => {
  test("running entry → loading state", () => {
    const data = computeSubagentCardData(makeEntry({ status: "running" }));
    expect(data.state).toBe("loading");
  });

  test("pending entry → loading state", () => {
    const data = computeSubagentCardData(makeEntry({ status: "pending" }));
    expect(data.state).toBe("loading");
  });

  test("awaiting_input entry → loading state", () => {
    const data = computeSubagentCardData(
      makeEntry({ status: "awaiting_input" }),
    );
    expect(data.state).toBe("loading");
  });

  test("completed entry → complete state", () => {
    const data = computeSubagentCardData(makeEntry({ status: "completed" }));
    expect(data.state).toBe("complete");
  });

  test("failed entry → error state", () => {
    const data = computeSubagentCardData(makeEntry({ status: "failed" }));
    expect(data.state).toBe("error");
  });

  test("aborted entry → error state", () => {
    const data = computeSubagentCardData(makeEntry({ status: "aborted" }));
    expect(data.state).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Step mapping
// ---------------------------------------------------------------------------

describe("computeSubagentCardData — step mapping", () => {
  test("text event becomes a thinking step trimmed to 160 chars", () => {
    const longText = "x".repeat(300);
    const data = computeSubagentCardData(
      makeEntry({
        events: [makeEvent({ type: "text", content: longText })],
      }),
    );
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    expect(step.kind).toBe("thinking");
    if (step.kind === "thinking") {
      // 159 chars + ellipsis = 160.
      expect(step.text.length).toBe(160);
      expect(step.text.endsWith("…")).toBe(true);
    }
  });

  test("empty text events are skipped", () => {
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent({ type: "text", content: "   " }),
          makeEvent({ type: "text", content: "" }),
        ],
      }),
    );
    expect(data.steps).toHaveLength(0);
  });

  test("tool_call event becomes a running tool step", () => {
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "file_read",
            toolUseId: "tu-file-1",
            content: "src/foo.ts",
          }),
        ],
      }),
    );
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    expect(step.kind).toBe("tool");
    if (step.kind === "tool") {
      // `file_read` isn't a known branch in `deriveStepLabelFromName`, so
      // it falls through to the default "Running <Name>" path with the
      // bolt icon.
      expect(step.title).toBe("Running File Read");
      expect(step.info).toBe("src/foo.ts");
      expect(step.status).toBe("running");
      expect(step.toolCallId).toBe("tu-file-1");
      expect(step.iconName).toBe("bolt");
    }
  });

  test("tool_call for bash uses tool-specific title + icon (Fix 1)", () => {
    // Regression guard: before Fix 1, every tool step in the subagent
    // inline card rendered the bolt icon and a generic "Using <Tool>"
    // title. After Fix 1, `mapToolEventToStep` routes through the shared
    // `deriveStepLabelFromName` so bash → "Working" / terminal icon.
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "bash",
            toolUseId: "tu-bash-1",
            content: "ls -la",
          }),
        ],
      }),
    );
    const step = data.steps[0]!;
    expect(step.kind).toBe("tool");
    if (step.kind === "tool") {
      expect(step.title).toBe("Working");
      expect(step.iconName).toBe("terminal");
      expect(step.info).toBe("ls -la");
    }
  });

  test("tool_call → tool_result transitions the step to completed with a duration", () => {
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "bash",
              content: "ls",
              timestamp: NOW,
            },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "bash",
              content: "ok",
              timestamp: NOW + 2500,
            },
            1,
          ),
        ],
      }),
    );
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    expect(step.kind).toBe("tool");
    if (step.kind === "tool") {
      expect(step.status).toBe("completed");
      expect(step.durationLabel).toBe("3s");
    }
  });

  test("equal timestamps (synthetic detail events) yield no durationLabel", () => {
    // `mapDetailEvents` stamps every fetched-history event with the same
    // `Date.now()`, so a matched tool_call→tool_result delta is exactly 0.
    // `formatMs(0)` would render a misleading "<1s"; the label is omitted
    // instead. Only this equal-timestamp case is suppressed.
    const data = computeSubagentCardData(
      makeEntry({
        status: "completed",
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "bash",
            content: "ls",
            timestamp: NOW,
          }),
          makeEvent({
            type: "tool_result",
            toolName: "bash",
            content: "ok",
            timestamp: NOW,
          }),
        ],
      }),
    );
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    expect(step.kind).toBe("tool");
    if (step.kind === "tool") {
      expect(step.status).toBe("completed");
      expect(step.durationLabel).toBe("");
    }
  });

  test("a real positive delta still yields a duration", () => {
    // Real streaming events carry distinct receive-time `Date.now()`
    // values, so a genuine sub-second tool still shows a duration.
    const data = computeSubagentCardData(
      makeEntry({
        status: "completed",
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "bash",
            content: "ls",
            timestamp: NOW,
          }),
          makeEvent({
            type: "tool_result",
            toolName: "bash",
            content: "ok",
            timestamp: NOW + 200,
          }),
        ],
      }),
    );
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    expect(step.kind).toBe("tool");
    if (step.kind === "tool") {
      expect(step.status).toBe("completed");
      // Sub-second positive delta formats as "<1s" (not omitted).
      expect(step.durationLabel).toBe("<1s");
    }
  });

  test("tool_result with isError flips the tool step to error", () => {
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent({ type: "tool_call", toolName: "bash" }, 0),
          makeEvent(
            { type: "tool_result", toolName: "bash", isError: true },
            1,
          ),
        ],
      }),
    );
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    if (step.kind === "tool") {
      expect(step.status).toBe("error");
    }
  });

  test("error event appends a tool_error step and closes any in-flight tool", () => {
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent({ type: "tool_call", toolName: "bash" }, 0),
          makeEvent({ type: "error", content: "Out of context window" }, 1),
        ],
      }),
    );
    expect(data.steps).toHaveLength(2);
    const tool = data.steps[0]!;
    const err = data.steps[1]!;
    if (tool.kind === "tool") expect(tool.status).toBe("error");
    expect(err.kind).toBe("tool_error");
    if (err.kind === "tool_error") {
      expect(err.message).toBe("Out of context window");
    }
  });

  test("tool_result without a matching in-flight tool is ignored", () => {
    const data = computeSubagentCardData(
      makeEntry({
        events: [makeEvent({ type: "tool_result", toolName: "bash" })],
      }),
    );
    expect(data.steps).toHaveLength(0);
  });

  test("out-of-order tool_call/tool_result with toolName matches the right step", () => {
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent({ type: "tool_call", toolName: "bash" }, 0),
          makeEvent({ type: "tool_call", toolName: "file_read" }, 1),
          // file_read finishes first.
          makeEvent({ type: "tool_result", toolName: "file_read" }, 2),
          makeEvent({ type: "tool_result", toolName: "bash" }, 3),
        ],
      }),
    );
    expect(data.steps).toHaveLength(2);
    const bash = data.steps[0]!;
    const fileRead = data.steps[1]!;
    if (bash.kind === "tool") expect(bash.status).toBe("completed");
    if (fileRead.kind === "tool") expect(fileRead.status).toBe("completed");
  });

  test("parallel calls to the same tool are disambiguated by toolUseId", () => {
    // Two bash calls in flight; the SECOND one's result lands first.
    // Matching by `toolName` alone would close the first step (wrong);
    // matching by `toolUseId` must close the second.
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "bash",
              toolUseId: "tu-A",
              content: "first",
            },
            0,
          ),
          makeEvent(
            {
              type: "tool_call",
              toolName: "bash",
              toolUseId: "tu-B",
              content: "second",
            },
            1,
          ),
          makeEvent(
            { type: "tool_result", toolName: "bash", toolUseId: "tu-B" },
            2,
          ),
        ],
      }),
    );
    expect(data.steps).toHaveLength(2);
    const first = data.steps[0]!;
    const second = data.steps[1]!;
    // First bash call must still be running — its tu-A id wasn't closed.
    if (first.kind === "tool") {
      expect(first.status).toBe("running");
      expect(first.toolCallId).toBe("tu-A");
    }
    // Second call must be completed — its tu-B id matched the result.
    if (second.kind === "tool") {
      expect(second.status).toBe("completed");
      expect(second.toolCallId).toBe("tu-B");
    }
  });
});

// ---------------------------------------------------------------------------
// Web-tool group-label alignment with main chat
// ---------------------------------------------------------------------------

describe("computeSubagentCardData — web tools match main-chat group labels", () => {
  test("web_search tool_call → web_search step grouped under 'Searching the web'", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "running",
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "web_search",
            toolUseId: "tu-ws",
            content: "thermos history",
          }),
        ],
      }),
    );
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    expect(step.kind).toBe("web_search");
    if (step.kind === "web_search") {
      expect(step.title).toBe("Searching the web");
    }
    // The whole point of the change: the phase label matches main chat
    // ("Searching the web"), NOT the generic "Working" bucket.
    expect(phaseFromStep(step)).toBe("Searching the web");
  });

  test("web_search step carries detailKey = toolUseId so the timeline can open its detail", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "running",
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "web_search",
            toolUseId: "tu-ws",
            content: "thermos history",
          }),
        ],
      }),
    );
    const step = data.steps[0]!;
    expect(step.kind).toBe("web_search");
    if (step.kind === "web_search") {
      expect(step.detailKey).toBe("tu-ws");
    }
  });

  test("web_search tool_call → tool_result flips the title to past tense", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "completed",
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "web_search",
              toolUseId: "tu-ws",
              content: "thermos history",
              timestamp: NOW,
            },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "web_search",
              toolUseId: "tu-ws",
              result: "results...",
              timestamp: NOW + 2500,
            },
            1,
          ),
        ],
      }),
    );
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    expect(step.kind).toBe("web_search");
    if (step.kind === "web_search") {
      expect(step.title).toBe("Searched the web");
      expect(step.durationLabel).toBe("3s");
    }
    // Both tenses still group under the same label.
    expect(phaseFromStep(step)).toBe("Searching the web");
  });

  test("web_search query backfills from the result's searchQuery when the call carried none (live)", () => {
    // Live path: Anthropic resolves the web_search query only at completion, so
    // the `tool_call` arrives with no query and the matching `tool_result`
    // carries it (captured by the store from `activityMetadata`).
    const data = computeSubagentCardData(
      makeEntry({
        status: "running",
        events: [
          makeEvent(
            { type: "tool_call", toolName: "web_search", toolUseId: "tu-ws" },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "web_search",
              toolUseId: "tu-ws",
              result: "results...",
              searchQuery: "best thermos 2025",
            },
            1,
          ),
        ],
      }),
    );
    const step = data.steps[0]!;
    expect(step.kind).toBe("web_search");
    if (step.kind === "web_search") {
      expect(step.query).toBe("best thermos 2025");
    }
  });

  test("web_search keeps the call-time query over the result's searchQuery (history)", () => {
    // History/detail path: the query is already on the call (rebuilt from the
    // persisted resolved input), so it wins over any result-borne value.
    const data = computeSubagentCardData(
      makeEntry({
        status: "completed",
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "web_search",
              toolUseId: "tu-ws",
              input: { query: "call-time query" },
            },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "web_search",
              toolUseId: "tu-ws",
              result: "results...",
              searchQuery: "result query",
            },
            1,
          ),
        ],
      }),
    );
    const step = data.steps[0]!;
    if (step.kind === "web_search") {
      expect(step.query).toBe("call-time query");
    }
  });

  test("web_search result text is parsed into link chips (no clamp)", () => {
    // The subagent timeline carries the raw result text (Title\nURL pairs), not
    // structured metadata — parse it into chips like main chat does on reload.
    const resultText = [
      "First Result Title",
      "https://example.com/a",
      "Second Result Title",
      "https://www.foo.org/b",
      "Third Result Title",
      "https://bar.net/c",
    ].join("\n");
    const data = computeSubagentCardData(
      makeEntry({
        status: "completed",
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "web_search",
              toolUseId: "tu-ws",
              content: "q",
              timestamp: NOW,
            },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "web_search",
              toolUseId: "tu-ws",
              result: resultText,
              timestamp: NOW + 1000,
            },
            1,
          ),
        ],
      }),
    );
    const step = data.steps[0]!;
    expect(step.kind).toBe("web_search");
    if (step.kind === "web_search") {
      expect(step.title).toBe("Searched the web");
      // All three results kept inline — no 5-cap, no overflow bucket.
      expect(step.linkCount).toBe(3);
      expect(step.results.map((r) => r.url)).toEqual([
        "https://example.com/a",
        "https://www.foo.org/b",
        "https://bar.net/c",
      ]);
      expect(step.results[0]!.title).toBe("First Result Title");
      // `www.` stripped by the shared domain extractor.
      expect(step.results[1]!.domain).toBe("foo.org");
      expect(step.overflowResults ?? []).toHaveLength(0);
    }
  });

  test("web_search step carries its query (raw input preferred, content fallback) and it survives completion", () => {
    // From raw input.
    const fromInput = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "web_search",
            toolUseId: "tu-a",
            content: "summary",
            input: { query: "best laptops 2026" },
          }),
        ],
      }),
    ).steps[0]!;
    expect(fromInput.kind).toBe("web_search");
    if (fromInput.kind === "web_search") {
      expect(fromInput.query).toBe("best laptops 2026");
    }

    // Fallback to the content summary (which is the query for web_search).
    const fromContent = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "web_search",
            toolUseId: "tu-b",
            content: "fallback query",
          }),
        ],
      }),
    ).steps[0]!;
    if (fromContent.kind === "web_search") {
      expect(fromContent.query).toBe("fallback query");
    }

    // Query survives the tool_result completion (title flip + results fill).
    const completed = computeSubagentCardData(
      makeEntry({
        status: "completed",
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "web_search",
              toolUseId: "tu-c",
              content: "persisted query",
            },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "web_search",
              toolUseId: "tu-c",
              result: "Result\nhttps://x.com",
            },
            1,
          ),
        ],
      }),
    ).steps[0]!;
    if (completed.kind === "web_search") {
      expect(completed.title).toBe("Searched the web");
      expect(completed.query).toBe("persisted query");
    }
  });

  test("web_search chips parse from event.content when result is absent", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "completed",
        events: [
          makeEvent(
            { type: "tool_call", toolName: "web_search", toolUseId: "tu-ws" },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "web_search",
              toolUseId: "tu-ws",
              content: "Only Result\nhttps://solo.com/x",
            },
            1,
          ),
        ],
      }),
    );
    const step = data.steps[0]!;
    if (step.kind === "web_search") {
      expect(step.linkCount).toBe(1);
      expect(step.results[0]!.url).toBe("https://solo.com/x");
    }
  });

  test("web_search failure (isError result) → web_search_error step", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "completed",
        events: [
          makeEvent(
            { type: "tool_call", toolName: "web_search", toolUseId: "tu-ws" },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "web_search",
              toolUseId: "tu-ws",
              isError: true,
              result: "rate limited",
            },
            1,
          ),
        ],
      }),
    );
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    expect(step.kind).toBe("web_search_error");
    if (step.kind === "web_search_error") {
      expect(step.title).toBe("Web search failed");
      expect(step.errorMessage).toBe("rate limited");
      // Keyed to its tool id so the chip opens the full error in the detail.
      expect(step.detailKey).toBe("tu-ws");
    }
    // web_search_error still groups under "Searching the web".
    expect(phaseFromStep(step)).toBe("Searching the web");
  });

  test("web_search closed by a raw error event → web_search_error + tool_error row", () => {
    // Failed tool results arrive as type `"error"` (with isError/result) in the
    // subagent timeline; the in-flight web_search must convert to
    // web_search_error, mirroring how the tool path closes failed tools.
    const data = computeSubagentCardData(
      makeEntry({
        status: "failed",
        events: [
          makeEvent(
            { type: "tool_call", toolName: "web_search", toolUseId: "tu-ws" },
            0,
          ),
          makeEvent(
            {
              type: "error",
              toolName: "web_search",
              toolUseId: "tu-ws",
              content: "boom",
            },
            1,
          ),
        ],
      }),
    );
    // web_search_error step + the appended tool_error row.
    expect(data.steps).toHaveLength(2);
    expect(data.steps[0]!.kind).toBe("web_search_error");
    expect(data.steps[1]!.kind).toBe("tool_error");
  });

  test("web_fetch tool_call → 'Reading <domain>' thinking step grouped under 'Thinking'", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "running",
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "web_fetch",
            toolUseId: "tu-wf",
            content: "https://www.example.com/article",
          }),
        ],
      }),
    );
    expect(data.steps).toHaveLength(1);
    const step = data.steps[0]!;
    expect(step.kind).toBe("thinking");
    if (step.kind === "thinking") {
      // Scheme + leading www. stripped, matching main chat's web_fetch label.
      expect(step.text).toBe("Reading example.com");
      // Keyed to its tool id so the timeline pill is clickable (opens the
      // nested web_fetch detail), matching the payload built below.
      expect(step.detailKey).toBe("tu-wf");
    }
    // web_fetch maps to the "Thinking" group, exactly as main chat does.
    expect(phaseFromStep(step)).toBe("Thinking");
  });

  test("web_fetch step's detailKey resolves to a buildSubagentStepDetails payload (clickable)", () => {
    // Regression: the "Reading <domain>" pill must open a detail. The timeline
    // step and the detail map both key on `toolUseId`, so the pill's detailKey
    // has to exist in the payload map or clicking it is a no-op.
    const entry = makeEntry({
      events: [
        makeEvent({
          type: "tool_call",
          toolName: "web_fetch",
          toolUseId: "tu-wf",
          content: "https://www.example.com/article",
        }),
        makeEvent({
          type: "tool_result",
          toolName: "web_fetch",
          toolUseId: "tu-wf",
          content: "Final URL: https://www.example.com/article\nStatus: 200 OK",
        }),
      ],
    });
    const step = computeSubagentCardData(entry).steps[0]!;
    const details = buildSubagentStepDetails(entry.events);
    if (step.kind === "thinking") {
      expect(step.detailKey).toBe("tu-wf");
      expect(details.has(step.detailKey!)).toBe(true);
      // The payload routes to the web_fetch view (kind "tool" + toolName).
      expect(details.get(step.detailKey!)?.toolName).toBe("web_fetch");
    }
  });

  test("web_fetch prefers the raw input url over the content summary", () => {
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "web_fetch",
            toolUseId: "tu-wf",
            content: "truncated summ…",
            input: { url: "https://docs.vellum.ai/guide" },
          }),
        ],
      }),
    );
    const step = data.steps[0]!;
    if (step.kind === "thinking") {
      expect(step.text).toBe("Reading docs.vellum.ai");
    }
  });

  test("a web_search run reads as one 'Searching the web' group, not 'Working'", () => {
    // End-to-end label check: group the projected steps the same way the
    // timeline does and assert the section label.
    const data = computeSubagentCardData(
      makeEntry({
        status: "running",
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "web_search",
            toolUseId: "tu-ws",
            content: "q",
          }),
        ],
      }),
    );
    const sections = groupStepsByPhase(data.steps);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.label).toBe("Searching the web");
  });
});

// ---------------------------------------------------------------------------
// Header carousel content
// ---------------------------------------------------------------------------

describe("computeSubagentCardData — current step title/info", () => {
  test("no steps + running → Working + label", () => {
    const data = computeSubagentCardData(
      makeEntry({ status: "running", label: "Find tigers" }),
    );
    expect(data.currentStepTitle).toBe("Working");
    expect(data.currentStepInfo).toBe("Find tigers");
  });

  test("no steps + completed → Finished + label", () => {
    const data = computeSubagentCardData(
      makeEntry({ status: "completed", label: "Find tigers" }),
    );
    expect(data.currentStepTitle).toBe("Finished");
    expect(data.currentStepInfo).toBe("Find tigers");
  });

  test("no steps + failed → Failed + error message", () => {
    // Early-failure path: the subagent failed before emitting any
    // timeline events (e.g. spawn error or rate limit on first call).
    // The header must not read "Finished".
    const data = computeSubagentCardData(
      makeEntry({
        status: "failed",
        label: "Research crash",
        error: "Rate limited",
      }),
    );
    expect(data.currentStepTitle).toBe("Failed");
    expect(data.currentStepInfo).toBe("Rate limited");
  });

  test("no steps + aborted → Aborted + label fallback", () => {
    const data = computeSubagentCardData(
      makeEntry({ status: "aborted", label: "Find tigers" }),
    );
    expect(data.currentStepTitle).toBe("Aborted");
    // No error string → falls back to the label.
    expect(data.currentStepInfo).toBe("Find tigers");
  });

  test("latest step is text + running → Thinking + preview", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "running",
        events: [makeEvent({ type: "text", content: "Hmm, let me check." })],
      }),
    );
    expect(data.currentStepTitle).toBe("Thinking");
    expect(data.currentStepInfo).toBe("Hmm, let me check.");
  });

  test("latest step is text + completed → Thought + preview", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "completed",
        events: [makeEvent({ type: "text", content: "Done." })],
      }),
    );
    expect(data.currentStepTitle).toBe("Thought");
    expect(data.currentStepInfo).toBe("Done.");
  });

  test("latest step is a running tool → Working + info", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "running",
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "bash",
            content: "ls -la",
          }),
        ],
      }),
    );
    expect(data.currentStepTitle).toBe("Working");
    expect(data.currentStepInfo).toBe("ls -la");
  });

  test("latest step is a closed tool + still running → Finalizing", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "running",
        events: [
          makeEvent({ type: "tool_call", toolName: "bash" }, 0),
          makeEvent({ type: "tool_result", toolName: "bash" }, 1),
        ],
      }),
    );
    expect(data.currentStepTitle).toBe("Finalizing");
  });

  test("latest step is a closed tool + terminal → Used <Tool>", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "completed",
        events: [
          makeEvent({ type: "tool_call", toolName: "file_read" }, 0),
          makeEvent({ type: "tool_result", toolName: "file_read" }, 1),
        ],
      }),
    );
    expect(data.currentStepTitle).toBe("Used File Read");
  });

  test("latest step is a running web_search → 'Searching the web'", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "running",
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "web_search",
            toolUseId: "tu-ws",
            content: "q",
          }),
        ],
      }),
    );
    expect(data.currentStepTitle).toBe("Searching the web");
  });

  test("latest step is an error → Errored + message", () => {
    const data = computeSubagentCardData(
      makeEntry({
        status: "failed",
        events: [makeEvent({ type: "error", content: "rate-limited" })],
      }),
    );
    expect(data.currentStepTitle).toBe("Errored");
    expect(data.currentStepInfo).toBe("rate-limited");
  });
});

// ---------------------------------------------------------------------------
// Step count
// ---------------------------------------------------------------------------

describe("computeSubagentCardData — step count", () => {
  test("0 steps renders pluralised pill", () => {
    const data = computeSubagentCardData(makeEntry());
    expect(data.stepCount).toBe("0 steps");
  });

  test("1 step renders singular pill", () => {
    const data = computeSubagentCardData(
      makeEntry({
        events: [makeEvent({ type: "text", content: "alone" })],
      }),
    );
    expect(data.stepCount).toBe("1 step");
  });

  test("multiple steps render pluralised pill with count", () => {
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent({ type: "text", content: "a" }, 0),
          makeEvent({ type: "text", content: "b" }, 1),
          makeEvent({ type: "text", content: "c" }, 2),
        ],
      }),
    );
    expect(data.stepCount).toBe("3 steps");
  });
});

// ---------------------------------------------------------------------------
// mapToolEventToStep helper (exposed for the inline adapter contract)
// ---------------------------------------------------------------------------

describe("mapToolEventToStep", () => {
  test("derives a tool-specific title + icon for bash/host_bash (Fix 1)", () => {
    const step = mapToolEventToStep({
      id: "te-1",
      type: "tool_call",
      content: "summary",
      toolName: "host_bash",
      toolUseId: "tu-1",
      timestamp: 0,
    });
    // host_bash routes through `deriveStepLabelFromName`'s bash branch.
    expect(step.title).toBe("Working");
    expect(step.iconName).toBe("terminal");
    expect(step.info).toBe("summary");
    expect(step.status).toBe("running");
    expect(step.toolCallId).toBe("tu-1");
  });

  test("unknown tools fall through to the Running <Name> default with the bolt icon", () => {
    const step = mapToolEventToStep({
      id: "te-2",
      type: "tool_call",
      content: "details",
      toolName: "some_custom_tool",
      toolUseId: "tu-custom",
      timestamp: 0,
    });
    expect(step.title).toBe("Running Some Custom Tool");
    expect(step.iconName).toBe("bolt");
    // The default branch produces an empty info; the timeline summary is
    // surfaced as the info fallback so the pill still shows context.
    expect(step.info).toBe("details");
  });

  test("falls back to a generic title when toolName is missing", () => {
    const step = mapToolEventToStep({
      id: "te-3",
      type: "tool_call",
      content: "",
      timestamp: 0,
    });
    expect(step.title).toBe("Running tool");
    expect(step.toolCallId).toBe("");
  });

  test("derives the skill name from raw event.input, not the lossy summary", () => {
    // `skill` isn't a `summarizeToolInput` priority key, so `content` is empty
    // and the old reconstructInputBag path produced an info-less "Using a
    // skill". The raw input carries the name.
    const step = mapToolEventToStep({
      id: "te-skill",
      type: "tool_call",
      content: "",
      toolName: "skill",
      toolUseId: "tu-skill",
      input: { skill: "competitor-research" },
      timestamp: 0,
    });
    expect(step.title).toBe("Using a skill");
    expect(step.iconName).toBe("sparkle");
    expect(step.info).toBe("competitor-research");
  });

  test("surfaces the rich `activity` sentence from raw input", () => {
    // `reconstructInputBag` never carried `activity`, so the pill could never
    // show the rich sentence — only the raw command. The raw input does.
    const step = mapToolEventToStep({
      id: "te-act",
      type: "tool_call",
      content: "rg -n TODO src/",
      toolName: "bash",
      toolUseId: "tu-act",
      input: {
        command: "rg -n TODO src/",
        activity: "Searching the codebase for TODOs",
      },
      timestamp: 0,
    });
    expect(step.title).toBe("Working");
    expect(step.activity).toBe("Searching the codebase for TODOs");
  });

  test("computer action comes from raw input (not a summary key)", () => {
    const step = mapToolEventToStep({
      id: "te-cu",
      type: "tool_call",
      content: "",
      toolName: "computer",
      toolUseId: "tu-cu",
      input: { action: "screenshot" },
      timestamp: 0,
    });
    expect(step.title).toBe("Using computer");
    expect(step.info).toBe("screenshot");
  });

  test("falls back to reconstructInputBag when raw input is absent", () => {
    // Older events without `input` still get a sensible label from the summary.
    const step = mapToolEventToStep({
      id: "te-fallback",
      type: "tool_call",
      content: "ls -la",
      toolName: "bash",
      toolUseId: "tu-fallback",
      timestamp: 0,
    });
    expect(step.title).toBe("Working");
    expect(step.info).toBe("ls -la");
  });
});

// ---------------------------------------------------------------------------
// error event tool-step correlation (Fix 2)
// ---------------------------------------------------------------------------

describe("computeSubagentCardData — error event toolUseId correlation", () => {
  test("error with toolUseId closes only the matching parallel tool step", () => {
    // Two bash calls in-flight (tu-A first, tu-B second). An error event
    // for tu-A arrives while tu-B is still running. Only the tu-A step
    // should flip to "error"; tu-B remains "running".
    const data = computeSubagentCardData(
      makeEntry({
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "bash",
              toolUseId: "tu-A",
              content: "first",
            },
            0,
          ),
          makeEvent(
            {
              type: "tool_call",
              toolName: "bash",
              toolUseId: "tu-B",
              content: "second",
            },
            1,
          ),
          makeEvent(
            {
              type: "error",
              toolName: "bash",
              toolUseId: "tu-A",
              content: "boom",
            },
            2,
          ),
        ],
      }),
    );
    // 2 tool steps + 1 tool_error step.
    expect(data.steps).toHaveLength(3);
    const first = data.steps[0]!;
    const second = data.steps[1]!;
    if (first.kind === "tool") {
      expect(first.toolCallId).toBe("tu-A");
      expect(first.status).toBe("error");
    }
    if (second.kind === "tool") {
      expect(second.toolCallId).toBe("tu-B");
      expect(second.status).toBe("running");
    }
    const err = data.steps[2]!;
    expect(err.kind).toBe("tool_error");
    if (err.kind === "tool_error") {
      expect(err.message).toBe("boom");
    }
  });
});

// ---------------------------------------------------------------------------
// buildSubagentStepDetails — nested tool-detail payload map
// ---------------------------------------------------------------------------

describe("buildSubagentStepDetails", () => {
  test("tool_call + tool_result → one completed payload with raw input/result + duration", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "bash",
              toolUseId: "tu-1",
              content: "ls -la",
              input: { command: "ls -la" },
              timestamp: NOW,
            },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "bash",
              toolUseId: "tu-1",
              result: "total 0",
              timestamp: NOW + 2500,
            },
            1,
          ),
        ],
      }).events,
    );
    expect(details.size).toBe(1);
    const payload = details.get("tu-1")!;
    expect(payload.toolCallId).toBe("tu-1");
    expect(payload.toolName).toBe("bash");
    // Raw input is preserved verbatim (not the reconstructed summary bag).
    expect(payload.input).toEqual({ command: "ls -la" });
    expect(payload.result).toBe("total 0");
    expect(payload.status).toBe("completed");
    expect(payload.durationLabel).toBe("3s");
    expect(payload.kind).toBe("tool");
  });

  test("text event → thinking payload with the full, un-truncated content", () => {
    const content = "Line one.\n\nLine two with   many   spaces preserved.";
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [makeEvent({ type: "text", content }, 0)],
      }).events,
    );
    expect(details.size).toBe(1);
    const payload = details.get("te-0")!;
    expect(payload.kind).toBe("thinking");
    expect(payload.status).toBe("completed");
    // Full content verbatim — NOT the collapsed/truncated timeline preview.
    expect(payload.thinkingText).toBe(content);
  });

  test("web_search tool_call + tool_result → web_search payload with query + parsed sources", () => {
    const resultText = [
      "First Result Title",
      "https://example.com/a",
      "Second Result Title",
      "https://foo.org/b",
    ].join("\n");
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "web_search",
              toolUseId: "tu-ws",
              input: { query: "best vector databases" },
              timestamp: NOW,
            },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "web_search",
              toolUseId: "tu-ws",
              result: resultText,
              timestamp: NOW + 1500,
            },
            1,
          ),
        ],
      }).events,
    );
    expect(details.size).toBe(1);
    const payload = details.get("tu-ws")!;
    // A dedicated web_search payload (NOT the generic "tool" body) carrying the
    // query + the parsed source list for the nested detail view.
    expect(payload.kind).toBe("web_search");
    expect(payload.searchQuery).toBe("best vector databases");
    expect(payload.status).toBe("completed");
    expect(payload.searchResults?.map((r) => r.url)).toEqual([
      "https://example.com/a",
      "https://foo.org/b",
    ]);
  });

  test("web_search payload backfills searchQuery from the result when the call carried none (live)", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            { type: "tool_call", toolName: "web_search", toolUseId: "tu-ws" },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "web_search",
              toolUseId: "tu-ws",
              result: "results...",
              searchQuery: "best thermos 2025",
            },
            1,
          ),
        ],
      }).events,
    );
    const payload = details.get("tu-ws")!;
    expect(payload.kind).toBe("web_search");
    expect(payload.searchQuery).toBe("best thermos 2025");
  });

  test("whitespace-only text event produces no thinking payload", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [makeEvent({ type: "text", content: "   \n  " }, 0)],
      }).events,
    );
    expect(details.size).toBe(0);
  });

  test("falls back to event.content for result when result is absent", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            { type: "tool_call", toolName: "bash", toolUseId: "tu-1" },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "bash",
              toolUseId: "tu-1",
              content: "fallback output",
            },
            1,
          ),
        ],
      }).events,
    );
    expect(details.get("tu-1")!.result).toBe("fallback output");
  });

  // Codex review (P2): a FAILED tool's error output must stay inspectable in
  // the nested detail. `buildSubagentStepDetails` carries the error content into
  // the payload's `result` (status "error"), and `ToolDetailBody` renders
  // `result` in its Output section regardless of status — so clicking the pill
  // surfaces WHY the tool failed, not just that it did. Both the fetched-history
  // shape (`tool_result` + `isError`) and the live shape (a raw `error` event
  // carrying the content) resolve through the same branch, so both are covered.
  test("failed tool_result (isError) → payload preserves the error output, status error", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            { type: "tool_call", toolName: "bash", toolUseId: "tu-1" },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "bash",
              toolUseId: "tu-1",
              isError: true,
              result: "bash: command not found: foo",
            },
            1,
          ),
        ],
      }).events,
    );
    const payload = details.get("tu-1")!;
    expect(payload.status).toBe("error");
    expect(payload.result).toBe("bash: command not found: foo");
  });

  test("failed tool delivered as a raw error event → payload preserves the content", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            { type: "tool_call", toolName: "bash", toolUseId: "tu-1" },
            0,
          ),
          makeEvent(
            {
              type: "error",
              toolName: "bash",
              toolUseId: "tu-1",
              isError: true,
              content: "permission denied",
            },
            1,
          ),
        ],
      }).events,
    );
    const payload = details.get("tu-1")!;
    expect(payload.status).toBe("error");
    expect(payload.result).toBe("permission denied");
  });

  test("failed web_search → payload kept (status error) with the full untruncated error", () => {
    // The timeline chip shows only a `trimTextPreview` snippet; the detail must
    // keep the FULL provider error so the user can inspect why the search failed
    // — parity with a failed tool. Keyed by the tool id the chip's `detailKey`
    // points at, so it's reachable (NOT filtered out as a dead entry).
    const longError =
      "provider error: backend 503; " + "rate limited; ".repeat(20);
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            { type: "tool_call", toolName: "web_search", toolUseId: "tu-ws" },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "web_search",
              toolUseId: "tu-ws",
              isError: true,
              result: longError,
            },
            1,
          ),
        ],
      }).events,
    );
    const payload = details.get("tu-ws")!;
    expect(payload).toBeDefined();
    expect(payload.kind).toBe("web_search");
    expect(payload.status).toBe("error");
    expect(payload.result).toBe(longError);
    expect(payload.result!.length).toBeGreaterThan(160);
  });

  test("in-flight tool_call with no result → running payload, result undefined", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "bash",
              toolUseId: "tu-1",
              input: { command: "sleep 5" },
            },
            0,
          ),
        ],
      }).events,
    );
    expect(details.size).toBe(1);
    const payload = details.get("tu-1")!;
    expect(payload.status).toBe("running");
    expect(payload.result).toBeUndefined();
    expect(payload.durationLabel).toBe("");
    expect(payload.input).toEqual({ command: "sleep 5" });
  });

  test("tool_call with empty toolUseId is skipped (can't be keyed/clicked)", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [makeEvent({ type: "tool_call", toolName: "bash" })],
      }).events,
    );
    expect(details.size).toBe(0);
  });

  test("parallel calls to the same tool with distinct ids → two payloads matched by id", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            {
              type: "tool_call",
              toolName: "bash",
              toolUseId: "tu-A",
              input: { command: "first" },
            },
            0,
          ),
          makeEvent(
            {
              type: "tool_call",
              toolName: "bash",
              toolUseId: "tu-B",
              input: { command: "second" },
            },
            1,
          ),
          // The SECOND call's result lands first; must close tu-B, not tu-A.
          makeEvent(
            {
              type: "tool_result",
              toolName: "bash",
              toolUseId: "tu-B",
              result: "second done",
            },
            2,
          ),
        ],
      }).events,
    );
    expect(details.size).toBe(2);
    const a = details.get("tu-A")!;
    const b = details.get("tu-B")!;
    expect(a.status).toBe("running");
    expect(a.result).toBeUndefined();
    expect(a.input).toEqual({ command: "first" });
    expect(b.status).toBe("completed");
    expect(b.result).toBe("second done");
    expect(b.input).toEqual({ command: "second" });
  });

  test("isError result → error status with the result preserved", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            { type: "tool_call", toolName: "bash", toolUseId: "tu-1" },
            0,
          ),
          makeEvent(
            {
              type: "tool_result",
              toolName: "bash",
              toolUseId: "tu-1",
              isError: true,
              result: "command failed",
            },
            1,
          ),
        ],
      }).events,
    );
    const payload = details.get("tu-1")!;
    expect(payload.status).toBe("error");
    expect(payload.result).toBe("command failed");
  });

  test("a FAILED tool result mapped to a raw error event is still matched", () => {
    // When a tool fails, the store maps the inner event to type `"error"`
    // (not `"tool_result"`) but preserves `result` + `isError`. The matcher
    // must catch it regardless of the mapped type.
    const details = buildSubagentStepDetails(
      makeEntry({
        events: [
          makeEvent(
            { type: "tool_call", toolName: "bash", toolUseId: "tu-1" },
            0,
          ),
          makeEvent(
            {
              type: "error",
              toolName: "bash",
              toolUseId: "tu-1",
              isError: true,
              result: "boom",
            },
            1,
          ),
        ],
      }).events,
    );
    const payload = details.get("tu-1")!;
    expect(payload.status).toBe("error");
    expect(payload.result).toBe("boom");
  });

  test("equal timestamps (synthetic history) yield no durationLabel", () => {
    const details = buildSubagentStepDetails(
      makeEntry({
        status: "completed",
        events: [
          makeEvent({
            type: "tool_call",
            toolName: "bash",
            toolUseId: "tu-1",
            timestamp: NOW,
          }),
          makeEvent({
            type: "tool_result",
            toolName: "bash",
            toolUseId: "tu-1",
            result: "ok",
            timestamp: NOW,
          }),
        ],
      }).events,
    );
    const payload = details.get("tu-1")!;
    expect(payload.status).toBe("completed");
    expect(payload.durationLabel).toBe("");
  });
});

// ---------------------------------------------------------------------------
// `applyTimelineEvent` / `computeSubagentSteps` must reproduce the same `steps`
// the full projection produces, so the incremental-replay path can't drift from
// `computeSubagentCardData`.
// ---------------------------------------------------------------------------

describe("computeSubagentSteps / applyTimelineEvent reproduce computeSubagentCardData", () => {
  const fixtures: Array<{ name: string; events: SubagentTimelineEvent[] }> = [
    {
      name: "text + bash tool_call → tool_result",
      events: [
        makeEvent({ type: "text", content: "Investigating" }, 0),
        makeEvent(
          {
            type: "tool_call",
            toolName: "bash",
            toolUseId: "tu-1",
            content: "ls -la",
            timestamp: NOW,
          },
          1,
        ),
        makeEvent(
          {
            type: "tool_result",
            toolName: "bash",
            toolUseId: "tu-1",
            content: "ok",
            timestamp: NOW + 2500,
          },
          2,
        ),
      ],
    },
    {
      name: "web_search → result + web_fetch thinking step",
      events: [
        makeEvent(
          {
            type: "tool_call",
            toolName: "web_search",
            toolUseId: "ws-1",
            input: { query: "vellum docs" },
            timestamp: NOW,
          },
          0,
        ),
        makeEvent(
          {
            type: "tool_result",
            toolName: "web_search",
            toolUseId: "ws-1",
            result: "Vellum\nhttps://vellum.ai",
            timestamp: NOW + 1000,
          },
          1,
        ),
        makeEvent(
          {
            type: "tool_call",
            toolName: "web_fetch",
            toolUseId: "wf-1",
            input: { url: "https://vellum.ai/docs" },
            timestamp: NOW + 1100,
          },
          2,
        ),
      ],
    },
    {
      name: "in-flight tool closed by an error event",
      events: [
        makeEvent(
          {
            type: "tool_call",
            toolName: "bash",
            toolUseId: "tu-2",
            content: "rm -rf /",
            timestamp: NOW,
          },
          0,
        ),
        makeEvent(
          { type: "error", content: "permission denied", timestamp: NOW + 500 },
          1,
        ),
      ],
    },
  ];

  for (const { name, events } of fixtures) {
    test(`${name}: computeSubagentSteps matches the card projection`, () => {
      const expected = computeSubagentCardData(makeEntry({ events })).steps;
      const { steps } = computeSubagentSteps(events);
      expect(steps).toEqual(expected);
    });

    test(`${name}: applyTimelineEvent folded by hand matches computeSubagentSteps`, () => {
      const steps: ToolCallCardStep[] = [];
      const toolMeta: Array<ToolMeta | undefined> = [];
      for (const event of events) applyTimelineEvent(steps, toolMeta, event);
      expect(steps).toEqual(computeSubagentSteps(events).steps);
    });
  }
});

// ---------------------------------------------------------------------------
// Heavy projections recompute only when `entry.events` changes
//
// The panel keys its two heavy O(n) walks (`computeSubagentSteps` and
// `buildSubagentStepDetails`) on `entry.events`, not `entry`. The store bumps
// `entry` identity on every token/status/usage update while keeping
// `entry.events` reference-stable, so projecting from `entry.events` skips the
// walk when only the status/usage changed — and re-runs when the event list
// itself changes. These tests pin that contract: projection is keyed on the
// `entry.events` reference.
// ---------------------------------------------------------------------------

describe("heavy projections are memoizable on entry.events", () => {
  // Minimal stand-in for dependency-keyed memoization: recompute only when the
  // dependency reference changes. Mirrors how the projection hooks
  // (`useSubagentSteps` / `useSubagentStepDetails`) recompute only when the
  // `entry.events` reference changes.
  function memoizeByDep<Dep, Result>(compute: (dep: Dep) => Result) {
    let lastDep: Dep | undefined;
    let lastResult: Result;
    let calls = 0;
    return {
      run(dep: Dep): Result {
        if (calls === 0 || dep !== lastDep) {
          calls += 1;
          lastDep = dep;
          lastResult = compute(dep);
        }
        return lastResult;
      },
      get calls() {
        return calls;
      },
    };
  }

  const events: SubagentTimelineEvent[] = [
    makeEvent({ type: "text", content: "Investigating" }, 0),
    makeEvent(
      { type: "tool_call", toolName: "bash", toolUseId: "tu-1", content: "ls" },
      1,
    ),
    makeEvent(
      { type: "tool_result", toolName: "bash", toolUseId: "tu-1", result: "ok" },
      2,
    ),
  ];

  test("computeSubagentSteps memoized on entry.events skips the walk across a token/status update", () => {
    // A token/status/usage update bumps `entry` identity but leaves
    // `entry.events` reference-stable — the same array instance.
    const entryA = makeEntry({ status: "running", events });
    const entryB = makeEntry({
      status: "completed",
      // Same `events` reference — only the surrounding entry changed.
      events: entryA.events,
      outputTokens: 42,
    });
    expect(entryA).not.toBe(entryB);
    expect(entryB.events).toBe(entryA.events);

    const memo = memoizeByDep((evts: SubagentTimelineEvent[]) =>
      computeSubagentSteps(evts),
    );
    const first = memo.run(entryA.events);
    const second = memo.run(entryB.events);
    // No recompute: the stable `events` reference is the only dependency.
    expect(memo.calls).toBe(1);
    expect(second).toBe(first);
    // And the cached result is still correct.
    expect(first.steps).toEqual(computeSubagentSteps(events).steps);
  });

  test("computeSubagentSteps memoized on entry.events re-runs when the event list changes", () => {
    const entryA = makeEntry({ events });
    // A new event appended → a new array reference (the store replaces it).
    const entryB = makeEntry({
      events: [...events, makeEvent({ type: "text", content: "done" }, 3)],
    });
    expect(entryB.events).not.toBe(entryA.events);

    const memo = memoizeByDep((evts: SubagentTimelineEvent[]) =>
      computeSubagentSteps(evts),
    );
    memo.run(entryA.events);
    const after = memo.run(entryB.events);
    expect(memo.calls).toBe(2);
    expect(after.steps).toEqual(computeSubagentSteps(entryB.events).steps);
  });

  test("buildSubagentStepDetails memoized on entry.events skips the walk across a token/status update", () => {
    const entryA = makeEntry({ status: "running", events });
    const entryB = makeEntry({
      status: "completed",
      events: entryA.events,
      inputTokens: 100,
    });
    expect(entryB.events).toBe(entryA.events);

    const memo = memoizeByDep((evts: SubagentTimelineEvent[]) =>
      buildSubagentStepDetails(evts),
    );
    const first = memo.run(entryA.events);
    const second = memo.run(entryB.events);
    expect(memo.calls).toBe(1);
    expect(second).toBe(first);
    expect(first.get("tu-1")?.status).toBe("completed");
  });
});
