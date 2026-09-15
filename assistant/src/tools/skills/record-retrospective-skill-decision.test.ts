import { describe, expect, test } from "bun:test";

import type { ToolContext } from "../types.js";
import { executeRecordRetrospectiveSkillDecision } from "./record-retrospective-skill-decision.js";

const context: ToolContext = {
  workingDir: "/tmp",
  conversationId: "run-1",
  trustClass: "guardian",
  requestOrigin: "memory_retrospective",
};

describe("record_retrospective_skill_decision", () => {
  test("maps the model payload to normalized decision rows", async () => {
    let recorded: Record<string, unknown> | undefined;
    const result = await executeRecordRetrospectiveSkillDecision(
      {
        monitoring_search_id: "search-1",
        outcome: "refined",
        reason: "The first candidate matches and needs one observed step.",
        candidates: [
          {
            skill_id: "deploy-web",
            decision: "selected",
            reason: "Same procedure and assistant-authored.",
          },
          {
            skill_id: "release-notes",
            decision: "not_selected",
            reason: "Different goal.",
          },
        ],
      },
      context,
      {
        resolveMonitoringContext: () => ({
          conversationId: "source-1",
          runConversationId: "run-1",
        }),
        recordDecisions: (args) => {
          recorded = args;
          return true;
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      recorded: true,
      monitoring_search_id: "search-1",
    });
    expect(recorded).toEqual({
      searchId: "search-1",
      runConversationId: "run-1",
      outcome: "refined",
      reason: "The first candidate matches and needs one observed step.",
      decisions: [
        {
          skillId: "deploy-web",
          decision: "selected",
          reason: "Same procedure and assistant-authored.",
        },
        {
          skillId: "release-notes",
          decision: "not_selected",
          reason: "Different goal.",
        },
      ],
    });
  });

  test("is a no-op when monitoring is not active", async () => {
    const result = await executeRecordRetrospectiveSkillDecision({}, context, {
      resolveMonitoringContext: () => null,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("not active");
  });

  test("does not make a retrospective retry when persistence fails", async () => {
    const result = await executeRecordRetrospectiveSkillDecision(
      {
        monitoring_search_id: "search-1",
        outcome: "skipped",
        reason: "No candidate applies.",
        candidates: [],
      },
      context,
      {
        resolveMonitoringContext: () => ({
          conversationId: "source-1",
          runConversationId: "run-1",
        }),
        recordDecisions: () => {
          throw new Error("memory db unavailable");
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Continue the retrospective");
  });
});
