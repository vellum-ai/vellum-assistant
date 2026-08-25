/**
 * Per-turn activation gate for plugin-owned tools.
 *
 * A plugin tool may declare `isActive({ modelProfileKey })`. The tool surface
 * is rebuilt on every provider call, so the predicate decides per call whether
 * the tool reaches the wire. These tests pin the contract: absent means always
 * active, throwing means inactive, the predicate sees the turn's resolved
 * profile key, it can only subtract from the surface, and it is honored for
 * plugin-owned tools only.
 */

import { afterEach, describe, expect, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import { isToolActiveForContext } from "../daemon/conversation-tool-setup.js";
import {
  getTool,
  registerPluginTools,
  registerSkillTools,
  unregisterPluginTools,
  unregisterSkillTools,
} from "../tools/registry.js";
import { finalizeTool } from "../tools/tool-defaults.js";
import type { ToolActivationContext, ToolDefinition } from "../tools/types.js";

const PLUGIN_NAME = "is_active_gate_test_plugin";
const SKILL_ID = "is_active_gate_test_skill";
const TOOL_NAME = "is_active_gate_test_tool";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {},
    toolsDisabledDepth: 0,
    hasNoClient: false,
    ...overrides,
  } as unknown as Conversation;
}

function registerPluginTool(definition: ToolDefinition): void {
  registerPluginTools(PLUGIN_NAME, [finalizeTool(definition, TOOL_NAME)]);
}

afterEach(() => {
  unregisterPluginTools(PLUGIN_NAME);
  unregisterSkillTools(SKILL_ID);
});

describe("plugin tool isActive gate", () => {
  test("a tool without isActive stays active", () => {
    registerPluginTool({ description: "no predicate" });

    expect(isToolActiveForContext(TOOL_NAME, conversation())).toBe(true);
  });

  test("finalizeTool preserves the predicate onto the registered tool", () => {
    const predicate = (): boolean => true;
    registerPluginTool({ isActive: predicate });

    expect(getTool(TOOL_NAME)?.isActive).toBe(predicate);
  });

  test("gates on the turn's model profile key", () => {
    registerPluginTool({
      isActive: ({ modelProfileKey }) => modelProfileKey === "text-only",
    });

    expect(
      isToolActiveForContext(
        TOOL_NAME,
        conversation({ currentTurnModelProfileKey: "text-only" }),
      ),
    ).toBe(true);
    expect(
      isToolActiveForContext(
        TOOL_NAME,
        conversation({ currentTurnModelProfileKey: "vision" }),
      ),
    ).toBe(false);
  });

  test("an unresolved profile key reaches the predicate as an empty string", () => {
    const seen: ToolActivationContext[] = [];
    registerPluginTool({
      isActive: (ctx) => {
        seen.push(ctx);
        return true;
      },
    });

    expect(isToolActiveForContext(TOOL_NAME, conversation())).toBe(true);
    expect(seen).toEqual([{ modelProfileKey: "" }]);
  });

  test("a predicate that throws counts as inactive", () => {
    registerPluginTool({
      isActive: () => {
        throw new Error("plugin bug");
      },
    });

    expect(isToolActiveForContext(TOOL_NAME, conversation())).toBe(false);
  });

  test("cannot re-enable a tool the host has already gated off", () => {
    registerPluginTool({ isActive: () => true });

    expect(
      isToolActiveForContext(
        TOOL_NAME,
        conversation({ toolsDisabledDepth: 1 }),
      ),
    ).toBe(false);
    expect(
      isToolActiveForContext(
        TOOL_NAME,
        conversation({ subagentAllowedTools: new Set(["bash"]) }),
      ),
    ).toBe(false);
    expect(
      isToolActiveForContext(
        TOOL_NAME,
        conversation({ diskPressureCleanupModeActive: true }),
      ),
    ).toBe(false);
  });

  test("is ignored for a non-plugin owner", () => {
    registerSkillTools(SKILL_ID, [
      finalizeTool({ isActive: () => false }, TOOL_NAME),
    ]);

    expect(isToolActiveForContext(TOOL_NAME, conversation())).toBe(true);
  });
});
