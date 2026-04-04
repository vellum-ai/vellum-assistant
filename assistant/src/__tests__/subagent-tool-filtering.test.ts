/**
 * Tests for the subagentAllowedTools mechanism in createResolveToolsCallback.
 *
 * Covers:
 * - Resolver filters core tools to only those in the subagent allowlist
 * - Resolver filters skill tool names through the subagent allowlist
 * - Resolver passes all tools through when subagentAllowedTools is undefined
 * - allowedToolNames on ctx is also filtered (defense in depth at executor level)
 */

import { describe, expect, mock, test } from "bun:test";

import type { SkillProjectionCache } from "../daemon/conversation-skill-tools.js";
import type { Message, ToolDefinition } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const mockProjectSkillTools = mock((_history: Message[], _opts: unknown) => ({
  allowedToolNames: new Set<string>(),
  toolDefinitions: [] as ToolDefinition[],
}));

mock.module("../daemon/conversation-skill-tools.js", () => ({
  projectSkillTools: mockProjectSkillTools,
}));

let mcpToolDefsForNextCall: ToolDefinition[] = [];

mock.module("../tools/registry.js", () => ({
  getAllToolDefinitions: () => [],
  getMcpToolDefinitions: () => mcpToolDefsForNextCall,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  createResolveToolsCallback,
  type SkillProjectionContext,
} from "../daemon/conversation-tool-setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolDef(name: string): ToolDefinition {
  return { name, description: `${name} tool`, input_schema: {} };
}

function makeCtx(
  overrides: Partial<SkillProjectionContext> = {},
): SkillProjectionContext {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: {} as SkillProjectionCache,
    coreToolNames: new Set(["file_read", "web_search", "bash", "file_write"]),
    toolsDisabledDepth: 0,
    ...overrides,
  };
}

const EMPTY_HISTORY: Message[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createResolveToolsCallback — subagentAllowedTools", () => {
  test("filters core tools to only those in the subagent allowlist", () => {
    const toolDefs = [
      makeToolDef("file_read"),
      makeToolDef("web_search"),
      makeToolDef("bash"),
      makeToolDef("file_write"),
    ];
    const ctx = makeCtx({
      subagentAllowedTools: new Set(["file_read", "web_search"]),
    });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);
    const names = tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("web_search");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("file_write");
  });

  test("passes all tools through when subagentAllowedTools is undefined", () => {
    const toolDefs = [
      makeToolDef("file_read"),
      makeToolDef("web_search"),
      makeToolDef("bash"),
      makeToolDef("file_write"),
    ];
    const ctx = makeCtx({ subagentAllowedTools: undefined });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);
    const names = tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("web_search");
    expect(names).toContain("bash");
    expect(names).toContain("file_write");
  });

  test("filters skill tool names through the subagent allowlist", () => {
    // Configure mock to return skill tools
    mockProjectSkillTools.mockReturnValueOnce({
      allowedToolNames: new Set(["skill_a", "skill_b", "skill_c"]),
      toolDefinitions: [],
    });

    const toolDefs = [makeToolDef("file_read")];
    const ctx = makeCtx({
      subagentAllowedTools: new Set(["file_read", "skill_b"]),
    });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    resolve(EMPTY_HISTORY);

    // allowedToolNames should include file_read and skill_b but not skill_a or skill_c
    expect(ctx.allowedToolNames!.has("file_read")).toBe(true);
    expect(ctx.allowedToolNames!.has("skill_b")).toBe(true);
    expect(ctx.allowedToolNames!.has("skill_a")).toBe(false);
    expect(ctx.allowedToolNames!.has("skill_c")).toBe(false);
  });

  test("allowedToolNames on ctx is filtered when subagentAllowedTools is set", () => {
    const toolDefs = [
      makeToolDef("file_read"),
      makeToolDef("web_search"),
      makeToolDef("bash"),
    ];
    const ctx = makeCtx({
      subagentAllowedTools: new Set(["file_read", "web_search"]),
    });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    resolve(EMPTY_HISTORY);

    // Defense in depth: the allowedToolNames gate on ctx must also be scoped
    expect(ctx.allowedToolNames!.has("file_read")).toBe(true);
    expect(ctx.allowedToolNames!.has("web_search")).toBe(true);
    expect(ctx.allowedToolNames!.has("bash")).toBe(false);
  });

  test("filters MCP tools through the subagent allowlist", () => {
    mcpToolDefsForNextCall = [
      makeToolDef("mcp_tool_a"),
      makeToolDef("mcp_tool_b"),
      makeToolDef("mcp_tool_c"),
    ];

    const toolDefs = [makeToolDef("file_read")];
    const ctx = makeCtx({
      subagentAllowedTools: new Set(["file_read", "mcp_tool_b"]),
    });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);
    const names = tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("mcp_tool_b");
    expect(names).not.toContain("mcp_tool_a");
    expect(names).not.toContain("mcp_tool_c");
  });

  test("passes all MCP tools through when subagentAllowedTools is undefined", () => {
    mcpToolDefsForNextCall = [
      makeToolDef("mcp_tool_a"),
      makeToolDef("mcp_tool_b"),
    ];

    const toolDefs = [makeToolDef("file_read")];
    const ctx = makeCtx({ subagentAllowedTools: undefined });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);
    const names = tools.map((t) => t.name);
    expect(names).toContain("file_read");
    expect(names).toContain("mcp_tool_a");
    expect(names).toContain("mcp_tool_b");
  });

  test("includes all skill tools in allowedToolNames when subagentAllowedTools is undefined", () => {
    mockProjectSkillTools.mockReturnValueOnce({
      allowedToolNames: new Set(["skill_a", "skill_b"]),
      toolDefinitions: [],
    });

    const toolDefs = [makeToolDef("file_read")];
    const ctx = makeCtx({ subagentAllowedTools: undefined });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    resolve(EMPTY_HISTORY);

    expect(ctx.allowedToolNames!.has("file_read")).toBe(true);
    expect(ctx.allowedToolNames!.has("skill_a")).toBe(true);
    expect(ctx.allowedToolNames!.has("skill_b")).toBe(true);
  });
});
