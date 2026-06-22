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

  test("respects subagentAllowedTools — tools outside the allowlist are inactive", () => {
    // Mirrors `createResolveToolsCallback`'s post-filter so callers see the
    // same final tool set the LLM receives.
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(),
      toolsDisabledDepth: 0,
      hasNoClient: false,
      isSubagent: true,
      subagentAllowedTools: new Set(["bash"]),
    };

    expect(isToolActiveForContext("bash", ctx)).toBe(true);
    expect(isToolActiveForContext("ask_question", ctx)).toBe(false);
    expect(isToolActiveForContext(TEST_TOOL_NAME, ctx)).toBe(false);
  });

  test("execution gate mode keeps non-allowlisted tools visible (allowlist enforced at execution time)", () => {
    // `subagentToolGateMode: "execution"` keeps the full tool surface on the
    // wire for provider prompt-cache parity; the executor callback rejects
    // non-allowlisted calls instead.
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(),
      toolsDisabledDepth: 0,
      hasNoClient: false,
      subagentAllowedTools: new Set(["remember"]),
      subagentToolGateMode: "execution",
    };

    expect(isToolActiveForContext("remember", ctx)).toBe(true);
    expect(isToolActiveForContext("bash", ctx)).toBe(true);
  });

  test("explicit wire gate mode filters exactly like the absent default", () => {
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(),
      toolsDisabledDepth: 0,
      hasNoClient: false,
      subagentAllowedTools: new Set(["remember"]),
      subagentToolGateMode: "wire",
    };

    expect(isToolActiveForContext("remember", ctx)).toBe(true);
    expect(isToolActiveForContext("bash", ctx)).toBe(false);
  });

  test("execution gate mode still applies non-allowlist filters (toolsDisabledDepth)", () => {
    // The execution gate only bypasses the subagent allowlist's wire filter;
    // every other visibility rule still applies.
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(),
      toolsDisabledDepth: 1,
      hasNoClient: false,
      subagentAllowedTools: new Set(["remember"]),
      subagentToolGateMode: "execution",
    };

    expect(isToolActiveForContext("remember", ctx)).toBe(false);
    expect(isToolActiveForContext("bash", ctx)).toBe(false);
  });

  test("returns false for every tool when toolsDisabledDepth > 0", () => {
    // `createResolveToolsCallback` returns an empty tool list when tools are
    // disabled; mirror it here so this helper reports the same final tool set.
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(),
      toolsDisabledDepth: 1,
      hasNoClient: false,
    };

    expect(isToolActiveForContext("bash", ctx)).toBe(false);
    expect(isToolActiveForContext("ask_question", ctx)).toBe(false);
  });

  test("under disk-pressure cleanup mode, only cleanup-safe tools are active", () => {
    // `createResolveToolsCallback` restricts the turn to cleanup-safe tools
    // (`file_remove`, `bash`, etc.); ensure the helper agrees.
    const ctx: SkillProjectionContext = {
      skillProjectionState: new Map(),
      skillProjectionCache: {},
      coreToolNames: new Set(),
      toolsDisabledDepth: 0,
      hasNoClient: false,
      diskPressureCleanupModeActive: true,
    };

    // `bash` is in DISK_PRESSURE_CLEANUP_TOOL_NAMES; `ask_question` is not.
    expect(isToolActiveForContext("bash", ctx)).toBe(true);
    expect(isToolActiveForContext("ask_question", ctx)).toBe(false);
  });
});
