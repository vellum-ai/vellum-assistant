/**
 * Tests for the tool-less-conversation system-prompt notice.
 *
 * A manual "analyze conversation" run strips every tool from the conversation
 * (`setSubagentAllowedTools(new Set())`) as a prompt-injection defense over
 * attacker-influenced transcript content. If the user keeps chatting in that
 * conversation, every later turn also runs with zero tools while the default
 * system prompt still describes a tool-using assistant — so the model emits
 * raw tool-call JSON as plain text. The notice tells the model there are no
 * tools and to answer from context instead.
 *
 * Covers:
 * - `isToollessConversationSurface` truth table (the durable per-conversation
 *   signal, excluding the transient `toolsDisabledDepth` disable).
 * - Parity: the predicate reports empty exactly when `createResolveToolsCallback`
 *   actually resolves zero tools for the empty-wire-allowlist case.
 * - `withToollessConversationNotice` appends the notice for tool-less
 *   conversations and leaves normal conversations untouched.
 */

import { describe, expect, mock, test } from "bun:test";

import type { SkillProjectionCache } from "../daemon/conversation-skill-tools.js";
import type { Message, ToolDefinition } from "../providers/types.js";

// Keep the skill projection empty so resolved tools come only from base defs.
mock.module("../daemon/conversation-skill-tools.js", () => ({
  projectSkillTools: mock((_history: Message[], _opts: unknown) => ({
    allowedToolNames: new Set<string>(),
    toolDefinitions: [],
  })),
}));

import {
  createResolveToolsCallback,
  isToollessConversationSurface,
  type SkillProjectionContext,
  TOOLLESS_CONVERSATION_NOTICE,
  withToollessConversationNotice,
} from "../daemon/conversation-tool-setup.js";

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

describe("isToollessConversationSurface", () => {
  test("false when no subagent allowlist is set (normal conversation)", () => {
    expect(isToollessConversationSurface(makeCtx())).toBe(false);
  });

  test("true when a wire-gated subagent allowlist is empty (analyze surface)", () => {
    const ctx = makeCtx({ subagentAllowedTools: new Set<string>() });
    expect(isToollessConversationSurface(ctx)).toBe(true);
  });

  test("false when the empty allowlist is enforced at execution time", () => {
    const ctx = makeCtx({
      subagentAllowedTools: new Set<string>(),
      subagentToolGateMode: "execution",
    });
    expect(isToollessConversationSurface(ctx)).toBe(false);
  });

  test("false when the allowlist has entries", () => {
    const ctx = makeCtx({ subagentAllowedTools: new Set(["tool_a"]) });
    expect(isToollessConversationSurface(ctx)).toBe(false);
  });

  test("false for the transient toolsDisabledDepth disable (kept cache-stable)", () => {
    // Pointer-generation turns bump `toolsDisabledDepth`, which toggles within a
    // conversation's lifetime. The durable predicate deliberately ignores it so
    // the notice stays stable per conversation.
    expect(
      isToollessConversationSurface(makeCtx({ toolsDisabledDepth: 1 })),
    ).toBe(false);
  });
});

describe("isToollessConversationSurface — parity with resolveTools", () => {
  test("reports empty exactly when the resolver yields zero tools", () => {
    const toolDefs = [makeToolDef("tool_a"), makeToolDef("tool_b")];

    const toollessCtx = makeCtx({ subagentAllowedTools: new Set<string>() });
    const resolveToolless = createResolveToolsCallback(toolDefs, toollessCtx)!;
    expect(resolveToolless(EMPTY_HISTORY)).toEqual([]);
    expect(isToollessConversationSurface(toollessCtx)).toBe(true);

    const normalCtx = makeCtx();
    const resolveNormal = createResolveToolsCallback(toolDefs, normalCtx)!;
    expect(resolveNormal(EMPTY_HISTORY).length).toBeGreaterThan(0);
    expect(isToollessConversationSurface(normalCtx)).toBe(false);
  });
});

describe("withToollessConversationNotice", () => {
  const BASE = "SOUL and identity prompt";

  test("appends the notice for a tool-less conversation", () => {
    const ctx = makeCtx({ subagentAllowedTools: new Set<string>() });
    const result = withToollessConversationNotice(BASE, ctx);
    expect(result.startsWith(BASE)).toBe(true);
    expect(result).toContain(TOOLLESS_CONVERSATION_NOTICE);
  });

  test("leaves a normal conversation's prompt untouched", () => {
    const result = withToollessConversationNotice(BASE, makeCtx());
    expect(result).toBe(BASE);
    expect(result).not.toContain(TOOLLESS_CONVERSATION_NOTICE);
  });

  test("does not append when the empty allowlist is execution-gated", () => {
    const ctx = makeCtx({
      subagentAllowedTools: new Set<string>(),
      subagentToolGateMode: "execution",
    });
    expect(withToollessConversationNotice(BASE, ctx)).toBe(BASE);
  });

  test("notice instructs the model not to emit tool-call syntax", () => {
    // The production incident: the model emitted raw tool-call JSON as text.
    expect(TOOLLESS_CONVERSATION_NOTICE.toLowerCase()).toContain(
      "tool-call syntax",
    );
    expect(TOOLLESS_CONVERSATION_NOTICE.toLowerCase()).toContain("no tools");
  });
});
