import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  SNAPSHOT_TOOL_CALL_SOURCE,
  type ToolCallSource,
} from "@/domains/chat/hooks/use-live-tool-call";
import { resolveSubagentStepDetail } from "@/domains/chat/utils/subagent-step-detail";
import type { ToolDetailPayload } from "@/stores/viewer-store";

const SUBAGENT: ToolCallSource = { kind: "subagent", subagentId: "sa-1" };

const eventDetail = (
  status: ToolDetailPayload["status"],
): ToolDetailPayload => ({
  toolCallId: "tu-1",
  toolName: "bash",
  title: "Running a command",
  activity: "",
  input: { command: "ls" },
  result: status === "running" ? undefined : "event-output",
  status,
  kind: "tool",
});

const runningCall: ChatMessageToolCall = {
  id: "tu-1",
  name: "bash",
  input: { command: "ls" },
};

const finishedCall: ChatMessageToolCall = {
  ...runningCall,
  result: "canonical-output",
  riskLevel: "low",
};

describe("resolveSubagentStepDetail", () => {
  test("prefers the canonical call and reads it live from the subagent", () => {
    const resolved = resolveSubagentStepDetail(
      finishedCall,
      eventDetail("completed"),
      SUBAGENT,
    );
    expect(resolved?.source).toBe(SUBAGENT);
    expect(resolved?.detail.result).toBe("canonical-output");
  });

  test("falls back to the event-built detail when the history lacks the call", () => {
    const resolved = resolveSubagentStepDetail(
      null,
      eventDetail("completed"),
      SUBAGENT,
    );
    expect(resolved?.source).toBe(SNAPSHOT_TOOL_CALL_SOURCE);
    expect(resolved?.detail.result).toBe("event-output");
  });

  test("keeps the event-built detail when it finished and the canonical copy still runs", () => {
    const resolved = resolveSubagentStepDetail(
      runningCall,
      eventDetail("completed"),
      SUBAGENT,
    );
    expect(resolved?.source).toBe(SNAPSHOT_TOOL_CALL_SOURCE);
    expect(resolved?.detail.result).toBe("event-output");
  });

  test("keeps the canonical call while both are still running", () => {
    expect(
      resolveSubagentStepDetail(runningCall, eventDetail("running"), SUBAGENT)
        ?.source,
    ).toBe(SUBAGENT);
  });

  test("resolves nothing when neither source has the step", () => {
    expect(
      resolveSubagentStepDetail(null, undefined, SUBAGENT),
    ).toBeUndefined();
  });
});
