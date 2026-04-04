import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  isToolActiveForContext,
  type SkillProjectionContext,
  SUBAGENT_ONLY_TOOL_NAMES,
} from "../daemon/conversation-tool-setup.js";

const TEST_TOOL_NAME = "__test_subagent_only_tool__";

describe("subagent-only tool filtering", () => {
  beforeEach(() => {
    SUBAGENT_ONLY_TOOL_NAMES.add(TEST_TOOL_NAME);
  });

  afterEach(() => {
    SUBAGENT_ONLY_TOOL_NAMES.delete(TEST_TOOL_NAME);
  });

  test("hides subagent-only tools from main conversations (isSubagent=false)", () => {
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(),
      toolsDisabledDepth: 0,
      hasNoClient: false,
      isSubagent: false,
    };

    expect(isToolActiveForContext(TEST_TOOL_NAME, ctx)).toBe(false);
  });

  test("hides subagent-only tools when isSubagent is undefined", () => {
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(),
      toolsDisabledDepth: 0,
      hasNoClient: false,
    };

    expect(isToolActiveForContext(TEST_TOOL_NAME, ctx)).toBe(false);
  });

  test("shows subagent-only tools to subagent conversations (isSubagent=true)", () => {
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(),
      toolsDisabledDepth: 0,
      hasNoClient: true,
      isSubagent: true,
    };

    expect(isToolActiveForContext(TEST_TOOL_NAME, ctx)).toBe(true);
  });

  test("does not affect regular tools when isSubagent is false", () => {
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(),
      toolsDisabledDepth: 0,
      hasNoClient: false,
      isSubagent: false,
    };

    // A regular tool not in SUBAGENT_ONLY_TOOL_NAMES should still be active
    expect(isToolActiveForContext("bash", ctx)).toBe(true);
  });
});
