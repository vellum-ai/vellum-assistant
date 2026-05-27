/**
 * Focused tests for the `skill_load` aggregator that powers the
 * Skills inspector tab. Pure-function tests — no DOM, no design
 * library — so they answer "did the aggregation correctly find
 * the loaded skill?" in isolation.
 */
import { describe, expect, test } from "bun:test";

import type {
  LLMContextSection,
  LLMRequestLogEntry,
} from "@vellumai/assistant-api";

import { aggregateSkillLoads } from "@/domains/chat/inspector/skill-load-aggregator";

function log(
  id: string,
  createdAt: number,
  responseSections: LLMContextSection[],
): LLMRequestLogEntry {
  return {
    id,
    createdAt,
    requestPayload: null,
    responsePayload: null,
    responseSections,
  };
}

function anthropicSkillLoad(skill: string): LLMContextSection {
  return {
    kind: "tool_use",
    toolName: "skill_load",
    data: { skill },
  };
}

function openaiSkillLoad(skill: string): LLMContextSection {
  return {
    kind: "function_call",
    toolName: "skill_load",
    data: { skill },
  };
}

describe("aggregateSkillLoads", () => {
  test("returns an empty array when no logs contain skill_load calls", () => {
    const logs = [
      log("a", 1, [
        { kind: "tool_use", toolName: "web_search", data: { query: "x" } },
        { kind: "message", text: "hi" },
      ]),
    ];
    expect(aggregateSkillLoads(logs)).toEqual([]);
  });

  test("finds a single Anthropic-style skill_load", () => {
    const logs = [log("a", 1000, [anthropicSkillLoad("document")])];
    const result = aggregateSkillLoads(logs);
    expect(result).toHaveLength(1);
    expect(result[0]!.skill).toBe("document");
    expect(result[0]!.loads).toHaveLength(1);
    expect(result[0]!.loads[0]!.logId).toBe("a");
    expect(result[0]!.loads[0]!.callNumber).toBe(1);
  });

  test("finds an OpenAI-style function_call skill_load", () => {
    const logs = [log("a", 1000, [openaiSkillLoad("app-builder")])];
    const result = aggregateSkillLoads(logs);
    expect(result).toHaveLength(1);
    expect(result[0]!.skill).toBe("app-builder");
  });

  test("groups multiple loads of the same skill across different calls", () => {
    const logs = [
      log("a", 1000, [anthropicSkillLoad("task-create")]),
      log("b", 2000, [anthropicSkillLoad("task-create")]),
      log("c", 3000, [anthropicSkillLoad("task-create")]),
    ];
    const result = aggregateSkillLoads(logs);
    expect(result).toHaveLength(1);
    expect(result[0]!.skill).toBe("task-create");
    expect(result[0]!.loads.map((l) => l.callNumber)).toEqual([1, 2, 3]);
  });

  test("sorts unique skills by first-appearance timestamp", () => {
    const logs = [
      // intentionally out of order — exercise the sort
      log("c", 3000, [anthropicSkillLoad("third")]),
      log("a", 1000, [anthropicSkillLoad("first")]),
      log("b", 2000, [anthropicSkillLoad("second")]),
    ];
    const result = aggregateSkillLoads(logs);
    expect(result.map((g) => g.skill)).toEqual(["first", "second", "third"]);
    // call numbers reflect chronological order after sort, not insertion order
    expect(result[0]!.loads[0]!.callNumber).toBe(1);
    expect(result[1]!.loads[0]!.callNumber).toBe(2);
    expect(result[2]!.loads[0]!.callNumber).toBe(3);
  });

  test("captures multiple skill_loads in a single call as separate entries", () => {
    const logs = [
      log("a", 1000, [
        anthropicSkillLoad("first"),
        { kind: "message", text: "loading two" },
        anthropicSkillLoad("second"),
      ]),
    ];
    const result = aggregateSkillLoads(logs);
    expect(result.map((g) => g.skill)).toEqual(["first", "second"]);
    expect(result[0]!.loads[0]!.sectionIndex).toBe(0);
    expect(result[1]!.loads[0]!.sectionIndex).toBe(2);
  });

  test("ignores tool_use sections whose tool is not skill_load", () => {
    const logs = [
      log("a", 1000, [
        { kind: "tool_use", toolName: "web_search", data: { skill: "spoof" } },
        { kind: "tool_use", toolName: "skill_execute", data: { tool: "x" } },
      ]),
    ];
    expect(aggregateSkillLoads(logs)).toEqual([]);
  });

  test("ignores skill_load sections with a missing or blank skill arg", () => {
    const logs = [
      log("a", 1000, [
        { kind: "tool_use", toolName: "skill_load", data: { skill: "" } },
        { kind: "tool_use", toolName: "skill_load", data: { skill: "   " } },
        { kind: "tool_use", toolName: "skill_load", data: {} },
        { kind: "tool_use", toolName: "skill_load", data: null },
        { kind: "tool_use", toolName: "skill_load" },
      ]),
    ];
    expect(aggregateSkillLoads(logs)).toEqual([]);
  });

  test("trims whitespace around skill ids before grouping", () => {
    const logs = [
      log("a", 1000, [
        { kind: "tool_use", toolName: "skill_load", data: { skill: " doc " } },
        { kind: "tool_use", toolName: "skill_load", data: { skill: "doc" } },
      ]),
    ];
    const result = aggregateSkillLoads(logs);
    expect(result).toHaveLength(1);
    expect(result[0]!.skill).toBe("doc");
    expect(result[0]!.loads).toHaveLength(2);
  });
});
