/**
 * Tests for resolveFirstClassSkillDefs: weak open models get loaded skill tools
 * exposed first-class (resolved from the registry by name), capable models do
 * not, and the turn allowlist still gates which defs are included.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveFirstClassSkillDefs } from "../daemon/conversation-tool-setup.js";
import { RiskLevel } from "../permissions/types.js";
import { registerSkillTools, unregisterSkillTools } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";

const MINIMAX = "accounts/fireworks/models/minimax-m3";
const CLAUDE = "claude-opus-4-8";

const SKILL_ID = "first-class-test-skill";

function makeSkillTool(name: string): Tool {
  return {
    name,
    description: `Test tool ${name}`,
    category: "testing",
    defaultRiskLevel: RiskLevel.Low,
    executionTarget: "host",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
    execute: async () => ({ content: "", isError: false }),
  };
}

describe("resolveFirstClassSkillDefs", () => {
  beforeEach(() => {
    registerSkillTools(SKILL_ID, [
      makeSkillTool("document_update"),
      makeSkillTool("document_create"),
    ]);
  });

  afterEach(() => {
    unregisterSkillTools(SKILL_ID);
  });

  const allowed = new Set(["document_update", "document_create"]);
  const turnAllowed = new Set([
    "document_update",
    "document_create",
    "skill_execute",
  ]);

  test("exposes loaded skill tools for a weak open model", () => {
    const defs = resolveFirstClassSkillDefs(allowed, turnAllowed, MINIMAX);
    expect(defs.map((d) => d.name).sort()).toEqual([
      "document_create",
      "document_update",
    ]);
  });

  test("returns nothing for a capable model", () => {
    const defs = resolveFirstClassSkillDefs(allowed, turnAllowed, CLAUDE);
    expect(defs).toEqual([]);
  });

  test("returns nothing when the model is unknown/absent", () => {
    expect(resolveFirstClassSkillDefs(allowed, turnAllowed, null)).toEqual([]);
    expect(resolveFirstClassSkillDefs(allowed, turnAllowed, undefined)).toEqual(
      [],
    );
  });

  test("respects the turn allowlist (subagent / exclude gating)", () => {
    // Only document_update is allowed this turn — document_create is filtered.
    const restricted = new Set(["document_update", "skill_execute"]);
    const defs = resolveFirstClassSkillDefs(allowed, restricted, MINIMAX);
    expect(defs.map((d) => d.name)).toEqual(["document_update"]);
  });

  test("skips names with no registered tool", () => {
    const withGhost = new Set([...allowed, "not_registered"]);
    const turn = new Set([...turnAllowed, "not_registered"]);
    const defs = resolveFirstClassSkillDefs(withGhost, turn, MINIMAX);
    expect(defs.map((d) => d.name).sort()).toEqual([
      "document_create",
      "document_update",
    ]);
  });

  test("each exposed def carries its real scalar schema (single-escape)", () => {
    const defs = resolveFirstClassSkillDefs(allowed, turnAllowed, MINIMAX);
    const update = defs.find((d) => d.name === "document_update");
    expect(update?.input_schema).toMatchObject({
      properties: { content: { type: "string" } },
      required: ["content"],
    });
  });
});
