/**
 * Tests for the toolsDisabledDepth mechanism in createResolveToolsCallback.
 *
 * Covers:
 * - Resolver returns empty tools when toolsDisabledDepth > 0
 * - Resolver returns normal tools when toolsDisabledDepth is back to 0
 * - allowedToolNames is cleared while disabled and restored on next normal call
 * - Depth counter survives overlapping increments/decrements
 */

import { describe, expect, mock, test } from "bun:test";

import type { SkillProjectionCache } from "../daemon/conversation-skill-tools.js";
import type { Message, ToolDefinition } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../daemon/conversation-skill-tools.js", () => ({
  projectSkillTools: mock((_history: Message[], _opts: unknown) => ({
    allowedToolNames: new Set<string>(),
    toolDefinitions: [],
  })),
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
    coreToolNames: new Set(["tool_a", "tool_b"]),
    toolsDisabledDepth: 0,
    ...overrides,
  };
}

const EMPTY_HISTORY: Message[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createResolveToolsCallback — toolsDisabledDepth", () => {
  test("returns undefined when no tool definitions provided", () => {
    const ctx = makeCtx();
    const resolve = createResolveToolsCallback([], ctx);
    expect(resolve).toBeUndefined();
  });

  test("returns normal tools when toolsDisabledDepth is 0", () => {
    const toolDefs = [makeToolDef("tool_a"), makeToolDef("tool_b")];
    const ctx = makeCtx();
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(tools.map((t) => t.name)).toContain("tool_a");
    expect(tools.map((t) => t.name)).toContain("tool_b");
    expect(ctx.allowedToolNames?.size).toBeGreaterThan(0);
  });

  test("returns empty tools when toolsDisabledDepth > 0", () => {
    const toolDefs = [makeToolDef("tool_a"), makeToolDef("tool_b")];
    const ctx = makeCtx({ toolsDisabledDepth: 1 });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);
    expect(tools).toEqual([]);
    expect(ctx.allowedToolNames).toEqual(new Set());
  });

  test("returns empty tools when toolsDisabledDepth is > 1 (overlapping callers)", () => {
    const toolDefs = [makeToolDef("tool_a")];
    const ctx = makeCtx({ toolsDisabledDepth: 3 });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    const tools = resolve(EMPTY_HISTORY);
    expect(tools).toEqual([]);
    expect(ctx.allowedToolNames).toEqual(new Set());
  });

  test("restores normal tools after depth returns to 0", () => {
    const toolDefs = [makeToolDef("tool_a"), makeToolDef("tool_b")];
    const ctx = makeCtx({ toolsDisabledDepth: 0 });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    // First call: normal
    let tools = resolve(EMPTY_HISTORY);
    expect(tools.length).toBeGreaterThanOrEqual(2);

    // Simulate pointer processor incrementing depth
    ctx.toolsDisabledDepth++;
    tools = resolve(EMPTY_HISTORY);
    expect(tools).toEqual([]);
    expect(ctx.allowedToolNames).toEqual(new Set());

    // Simulate pointer processor decrementing depth (back to 0)
    ctx.toolsDisabledDepth--;
    tools = resolve(EMPTY_HISTORY);
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(ctx.allowedToolNames!.has("tool_a")).toBe(true);
    expect(ctx.allowedToolNames!.has("tool_b")).toBe(true);
  });

  test("overlapping increments keep tools disabled until all decremented", () => {
    const toolDefs = [makeToolDef("tool_a")];
    const ctx = makeCtx();
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    // Two overlapping pointer requests
    ctx.toolsDisabledDepth++;
    ctx.toolsDisabledDepth++;
    expect(resolve(EMPTY_HISTORY)).toEqual([]);

    // First one finishes
    ctx.toolsDisabledDepth--;
    expect(ctx.toolsDisabledDepth).toBe(1);
    expect(resolve(EMPTY_HISTORY)).toEqual([]);

    // Second one finishes
    ctx.toolsDisabledDepth--;
    expect(ctx.toolsDisabledDepth).toBe(0);
    const tools = resolve(EMPTY_HISTORY);
    expect(tools.length).toBeGreaterThanOrEqual(1);
  });

  test("clears allowedToolNames on every disabled call", () => {
    const toolDefs = [makeToolDef("tool_a")];
    const ctx = makeCtx({ toolsDisabledDepth: 1 });
    const resolve = createResolveToolsCallback(toolDefs, ctx)!;

    // Pre-populate allowedToolNames as if a previous normal turn set them
    ctx.allowedToolNames = new Set(["tool_a", "skill_x"]);

    resolve(EMPTY_HISTORY);
    expect(ctx.allowedToolNames).toEqual(new Set());
  });
});
