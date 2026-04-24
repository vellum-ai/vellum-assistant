import { describe, expect, test } from "bun:test";

import {
  classifySlash,
  resolveSlash,
  type SlashContext,
} from "../daemon/conversation-slash.js";

function makeSlashContext(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    messageCount: 4,
    inputTokens: 1024,
    outputTokens: 256,
    maxInputTokens: 200000,
    model: "claude-opus-4-6",
    provider: "anthropic",
    estimatedCost: 0.03,
    ...overrides,
  };
}

async function resolveCommandsLines(context?: SlashContext): Promise<string[]> {
  const result = await resolveSlash("/commands", context);
  expect(result.kind).toBe("unknown");
  if (result.kind !== "unknown") {
    throw new Error("Expected /commands to resolve to kind=unknown");
  }
  return result.message.split("\n");
}

describe("resolveSlash /commands interface-aware help", () => {
  test("renders desktop command help for macOS", async () => {
    const lines = await resolveCommandsLines(
      makeSlashContext({ userMessageInterface: "macos" }),
    );
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ]);
    expect(lines).not.toContain("/model — Switch the active model");
  });

  test("renders iOS command help with /fork", async () => {
    const lines = await resolveCommandsLines(
      makeSlashContext({ userMessageInterface: "ios" }),
    );
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ]);
  });

  test("renders explicit cli command help", async () => {
    const lines = await resolveCommandsLines(
      makeSlashContext({ userMessageInterface: "cli" }),
    );
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
    ]);
  });

  test("keeps legacy fallback help when no interface is provided", async () => {
    const lines = await resolveCommandsLines(makeSlashContext());
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
    ]);
  });

  test("keeps context-free fallback without /status", async () => {
    const lines = await resolveCommandsLines();
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/models — List all available models",
    ]);
  });
});

describe("resolveSlash command contract", () => {
  test("keeps unsupported slash forms as passthrough", async () => {
    const slashForms = [
      "/commands foo",
      "/models foo",
      "/status foo",
      "/pair foo",
      "/pair",
      "/btw",
    ];

    for (const input of slashForms) {
      const result = await resolveSlash(
        input,
        makeSlashContext({ userMessageInterface: "macos" }),
      );
      expect(result).toEqual({ kind: "passthrough", content: input });
    }
  });


});

describe("classifySlash is a pure classifier matching resolveSlash kinds", () => {
  // Lookahead in `buildPassthroughBatch` must not run `resolveSlash`'s side
  // effects. The pure classifier is synchronous, takes no side-effecting
  // dependencies, and must agree with resolveSlash's `kind`.
  const cases: Array<{ input: string; kind: "passthrough" | "compact" | "unknown" }> = [
    { input: "/pair", kind: "passthrough" },
    { input: "/models", kind: "unknown" },
    { input: "/status", kind: "unknown" },
    { input: "/commands", kind: "unknown" },
    { input: "/compact", kind: "compact" },
    { input: "/model", kind: "unknown" },
    { input: "/model foo", kind: "unknown" },
    { input: "/opus", kind: "unknown" },
    { input: "hello", kind: "passthrough" },
    { input: "  /compact  ", kind: "compact" },
    { input: "/pair foo", kind: "passthrough" },
    { input: "/models foo", kind: "passthrough" },
  ];

  for (const { input, kind } of cases) {
    test(`classifies ${JSON.stringify(input)} as ${kind}`, async () => {
      expect(classifySlash(input)).toBe(kind);
      const resolved = await resolveSlash(
        input,
        makeSlashContext({ userMessageInterface: "macos" }),
      );
      expect(resolved.kind).toBe(kind);
    });
  }
});
