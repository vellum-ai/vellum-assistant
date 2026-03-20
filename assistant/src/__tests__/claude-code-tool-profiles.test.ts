import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the Agent SDK — prevents real subprocess spawning
// ---------------------------------------------------------------------------
const queryMock = mock(() => {
  // Returns an async iterable that yields a success result
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "result" as const,
        session_id: "test-session",
        subtype: "success" as const,
        result: "Done.",
      };
    },
  };
});

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

// Mock logger
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock config
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
  }),
}));

// Mock secure-keys — provide a fake Anthropic API key
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (name: string) => ({
    value: name === "anthropic" ? "fake-anthropic-key" : undefined,
    unreachable: false,
  }),
  getProviderKeyAsync: async (provider: string) =>
    provider === "anthropic" ? "fake-anthropic-key" : undefined,
}));

import { claudeCodeTool } from "../tools/claude-code/claude-code.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    conversationId: "test-session",
    workingDir: "/tmp/test",
    trustClass: "guardian",
    onOutput: () => {},
    ...overrides,
  } as ToolContext;
}

describe("claude_code tool profile support", () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  test("getDefinition includes profile parameter", () => {
    const def = claudeCodeTool.getDefinition();
    const props = (def.input_schema as Record<string, unknown>)
      .properties as Record<string, unknown>;
    expect(props.profile).toBeDefined();
  });

  test("rejects invalid profile", async () => {
    const result = await claudeCodeTool.execute(
      { prompt: "test", profile: "hacker" },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid profile");
  });

  test("accepts valid profiles without error", async () => {
    for (const profile of ["general", "researcher", "coder", "reviewer"]) {
      queryMock.mockClear();
      const result = await claudeCodeTool.execute(
        { prompt: "test", profile },
        makeContext(),
      );
      expect(result.isError).toBeFalsy();
    }
  });

  test("omitted profile defaults to general", async () => {
    const result = await claudeCodeTool.execute(
      { prompt: "test" },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
  });
});
