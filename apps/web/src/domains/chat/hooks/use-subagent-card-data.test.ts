/**
 * Tests for `computeSubagentCardData` — the pure projection that
 * `useSubagentCardData` wraps. Driving the pure function avoids the
 * React + Zustand context plumbing and keeps coverage focused on the
 * `SubagentEntry → ToolCallCardData` mapping.
 */

import { describe, expect, test } from "bun:test";

import {
  computeSubagentCardData,
  mapToolEventToStep,
} from "@/domains/chat/hooks/use-subagent-card-data.js";
import type {
  SubagentEntry,
  SubagentTimelineEvent,
} from "@/domains/subagents/subagent-store.js";

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
      expect(step.title).toBe("Using File Read");
      expect(step.info).toBe("src/foo.ts");
      expect(step.status).toBe("running");
      expect(step.toolCallId).toBe("tu-file-1");
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
  test("derives a Using <Tool> title from snake_case names", () => {
    const step = mapToolEventToStep({
      id: "te-1",
      type: "tool_call",
      content: "summary",
      toolName: "host_bash",
      toolUseId: "tu-1",
      timestamp: 0,
    });
    expect(step.title).toBe("Using Host Bash");
    expect(step.info).toBe("summary");
    expect(step.status).toBe("running");
    expect(step.toolCallId).toBe("tu-1");
  });

  test("falls back to a generic title when toolName is missing", () => {
    const step = mapToolEventToStep({
      id: "te-2",
      type: "tool_call",
      content: "",
      timestamp: 0,
    });
    expect(step.title).toBe("Running tool");
    expect(step.toolCallId).toBe("");
  });
});
