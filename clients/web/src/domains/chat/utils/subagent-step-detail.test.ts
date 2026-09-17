import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { resolveSubagentStepDetail } from "@/domains/chat/utils/subagent-step-detail";
import type { ToolDetailPayload } from "@/stores/viewer-store";

const eventDetail = (
  overrides: Partial<ToolDetailPayload> = {},
): ToolDetailPayload => ({
  toolCallId: "tu-1",
  toolName: "bash",
  title: "Running a command",
  activity: "",
  input: { command: "ls" },
  result: "event-output",
  status: "completed",
  kind: "tool",
  ...overrides,
});

const runningCall: ChatMessageToolCall = {
  id: "tu-1",
  name: "bash",
  input: { command: "ls" },
  riskLevel: "low",
};

describe("resolveSubagentStepDetail", () => {
  test("uses the event-built detail when the history lacks the call", () => {
    expect(resolveSubagentStepDetail(null, eventDetail())?.result).toBe(
      "event-output",
    );
  });

  test("uses the canonical call alone when the events carry no detail", () => {
    const detail = resolveSubagentStepDetail(
      { ...runningCall, result: "canonical-output" },
      undefined,
    );
    expect(detail?.result).toBe("canonical-output");
    expect(detail?.riskLevel).toBe("low");
  });

  test("keeps the canonical call's own values where it has them", () => {
    const detail = resolveSubagentStepDetail(
      { ...runningCall, result: "canonical-output" },
      eventDetail(),
    );
    expect(detail?.result).toBe("canonical-output");
    expect(detail?.status).toBe("completed");
  });

  test("fills a still-running canonical copy from the finished events", () => {
    const detail = resolveSubagentStepDetail(runningCall, eventDetail());
    expect(detail?.result).toBe("event-output");
    expect(detail?.status).toBe("completed");
    expect(detail?.riskLevel).toBe("low");
  });

  test("fills a result the canonical copy was completed without", () => {
    const detail = resolveSubagentStepDetail(
      { ...runningCall, completedAt: 1 },
      eventDetail(),
    );
    expect(detail?.result).toBe("event-output");
  });

  test("fills a web search's sources the canonical copy has no metadata for", () => {
    const sources = [
      {
        rank: 1,
        title: "Toronto",
        url: "https://example.com/toronto",
        domain: "example.com",
      },
    ];
    const detail = resolveSubagentStepDetail(
      {
        id: "tu-1",
        name: "web_search",
        input: { query: "toronto" },
        completedAt: 1,
      },
      eventDetail({
        toolName: "web_search",
        kind: "web_search",
        result: undefined,
        searchQuery: "toronto",
        searchResults: sources,
      }),
    );
    expect(detail?.kind).toBe("web_search");
    expect(detail?.searchResults).toEqual(sources);
  });

  test("derives the labels from the input the events filled in", () => {
    const detail = resolveSubagentStepDetail(
      { id: "tu-1", name: "bash", input: {} },
      eventDetail({
        input: { command: "ls", activity: "Listing the project files" },
      }),
    );
    expect(detail?.input).toEqual({
      command: "ls",
      activity: "Listing the project files",
    });
    expect(detail?.activity).toBe("Listing the project files");
  });

  test("takes the more final status of the two", () => {
    expect(
      resolveSubagentStepDetail(
        { ...runningCall, result: "ok" },
        eventDetail({ status: "error" }),
      )?.status,
    ).toBe("error");
    expect(
      resolveSubagentStepDetail(
        { ...runningCall, isError: true, result: "boom" },
        eventDetail({ status: "running", result: undefined }),
      )?.status,
    ).toBe("error");
  });

  test("resolves nothing when neither copy has the step", () => {
    expect(resolveSubagentStepDetail(null, undefined)).toBeUndefined();
  });
});
