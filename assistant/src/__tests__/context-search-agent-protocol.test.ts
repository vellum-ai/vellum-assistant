import { describe, expect, test } from "bun:test";

import {
  buildRecallAgentPrompt,
  FINISH_RECALL_TOOL_DEFINITION,
  RECALL_AGENT_TOOL_DEFINITIONS,
  SEARCH_SOURCES_TOOL_DEFINITION,
  truncateRecallEvidenceToBudget,
  validateFinishRecallPayload,
  validateRecallCitationIds,
} from "../memory/context-search/agent-protocol.js";
import type { RecallEvidence } from "../memory/context-search/types.js";

function makeEvidence(
  id: string,
  overrides: Partial<RecallEvidence> = {},
): RecallEvidence {
  return {
    id,
    source: "workspace",
    title: `${id} title`,
    locator: `${id}.md`,
    excerpt: `${id} excerpt`,
    ...overrides,
  };
}

function schemaProperties(tool: {
  input_schema: Record<string, unknown>;
}): Record<string, Record<string, unknown>> {
  return tool.input_schema.properties as Record<
    string,
    Record<string, unknown>
  >;
}

describe("recall agent protocol tool definitions", () => {
  test("defines bounded search_sources and finish_recall provider tools", () => {
    expect(RECALL_AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "search_sources",
      "finish_recall",
    ]);

    expect(SEARCH_SOURCES_TOOL_DEFINITION.input_schema.required).toEqual([
      "query",
      "reason",
    ]);
    expect(
      schemaProperties(SEARCH_SOURCES_TOOL_DEFINITION).sources.items,
    ).toEqual({
      type: "string",
      enum: ["memory", "pkb", "conversations", "workspace"],
    });
    expect(
      schemaProperties(SEARCH_SOURCES_TOOL_DEFINITION).limit,
    ).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 20,
    });

    expect(FINISH_RECALL_TOOL_DEFINITION.input_schema.required).toEqual([
      "answer",
      "confidence",
      "citation_ids",
    ]);
    expect(
      schemaProperties(FINISH_RECALL_TOOL_DEFINITION).confidence.enum,
    ).toEqual(["high", "medium", "low"]);
  });
});

describe("buildRecallAgentPrompt", () => {
  test("explains source boundaries, citation rules, conflicts, and finish tool use", () => {
    const prompt = buildRecallAgentPrompt({
      query: "What did Alice decide about launch timing?",
      availableSources: ["memory", "workspace"],
      evidence: [
        makeEvidence("ev-1", {
          source: "memory",
          excerpt: "Alice said launch should wait until Friday.",
        }),
        makeEvidence("ev-2", {
          source: "workspace",
          excerpt: "Launch notes say Tuesday is still possible.",
        }),
      ],
      maxSearchCalls: 2,
    });

    expect(prompt).toContain("memory: durable memory graph facts");
    expect(prompt).toContain("workspace: files and text");
    expect(prompt).not.toContain("pkb: personal knowledge base");
    expect(prompt).toContain("Do not use external web");
    expect(prompt).toContain("Do not guess");
    expect(prompt).toContain("For indirect references");
    expect(prompt).toContain("search those candidates");
    expect(prompt).toContain("not mandatory search terms");
    expect(prompt).toContain("Report conflicts");
    expect(prompt).toContain("finish_recall tool call");
    expect(prompt).toContain("Allowed citation_ids: ev-1, ev-2");
    expect(prompt).toContain("id: ev-1");
    expect(prompt).not.toContain("ev-404");
  });
});

describe("recall agent validation helpers", () => {
  test("rejects citations that are not present in the evidence table", () => {
    const result = validateRecallCitationIds(
      ["ev-1", "ev-404", "ev-1"],
      [makeEvidence("ev-1"), makeEvidence("ev-2")],
    );

    expect(result).toEqual({
      ok: false,
      validCitationIds: ["ev-1"],
      missingCitationIds: ["ev-404"],
    });
  });

  test("truncates evidence text to the active budget", () => {
    const result = truncateRecallEvidenceToBudget(
      [
        makeEvidence("ev-1", { excerpt: "abcdefghijklmnopqrstuvwxyz" }),
        makeEvidence("ev-2", { excerpt: "second excerpt" }),
      ],
      10,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.excerpt).toBe("abcdefg...");
    expect(
      result.reduce((sum, item) => sum + item.excerpt.length, 0),
    ).toBeLessThanOrEqual(10);
  });

  test("accepts well-formed finish payloads with supplied citations", () => {
    const result = validateFinishRecallPayload(
      {
        answer: "Alice chose Friday.",
        confidence: "high",
        citation_ids: ["ev-1", "ev-1"],
        unresolved: ["Tuesday note conflicts with Friday decision."],
      },
      [makeEvidence("ev-1")],
    );

    expect(result).toEqual({
      ok: true,
      finish: {
        answer: "Alice chose Friday.",
        confidence: "high",
        citationIds: ["ev-1"],
        unresolved: ["Tuesday note conflicts with Friday decision."],
      },
    });
  });

  test("converts malformed finish payloads into deterministic fallback signals", () => {
    expect(validateFinishRecallPayload("not an object", [])).toEqual({
      ok: false,
      reason: "malformed_finish_payload",
      finish: {
        answer: "No reliable answer could be produced by the recall agent.",
        confidence: "low",
        citationIds: [],
        unresolved: ["Recall agent returned malformed_finish_payload."],
      },
    });

    expect(
      validateFinishRecallPayload(
        { answer: "Unsupported", confidence: "certain", citation_ids: [] },
        [],
      ),
    ).toMatchObject({
      ok: false,
      reason: "invalid_confidence",
    });

    expect(
      validateFinishRecallPayload(
        {
          answer: "Uses missing citation.",
          confidence: "low",
          citation_ids: ["ev-404"],
        },
        [makeEvidence("ev-1")],
      ),
    ).toMatchObject({
      ok: false,
      reason: "unknown_citation_ids",
      missingCitationIds: ["ev-404"],
      finish: {
        answer: "No reliable answer could be produced by the recall agent.",
        confidence: "low",
        citationIds: [],
      },
    });
  });

  test("defaults to all source descriptions when available sources are omitted", () => {
    const prompt = buildRecallAgentPrompt({
      query: "deployment notes",
      evidence: [],
    });

    expect(prompt).toContain("memory: durable memory graph facts");
    expect(prompt).toContain("pkb: personal knowledge base");
    expect(prompt).toContain("conversations: past assistant conversations");
    expect(prompt).toContain("workspace: files and text");
  });
});
