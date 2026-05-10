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
      "/context — Show conversation context usage",
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
      "/context — Show conversation context usage",
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
      "/context — Show conversation context usage",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
    ]);
  });

  test("orders fallback help consistently when no interface is provided", async () => {
    const lines = await resolveCommandsLines(makeSlashContext());
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/context — Show conversation context usage",
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
  test("/context reports the resolved context budget", async () => {
    const result = await resolveSlash(
      "/context",
      makeSlashContext({ inputTokens: 75_000, maxInputTokens: 150_000 }),
    );
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") {
      throw new Error("Expected /context to resolve to kind=unknown");
    }
    expect(result.message).toContain("50%");
    expect(result.message).toContain("75,000 / 150,000 tokens");
  });

  test("keeps unsupported slash forms as passthrough", async () => {
    const slashForms = [
      "/commands foo",
      "/context foo",
      "/models foo",
      "/status foo",
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

describe("resolveSlash /compact target override", () => {
  test("plain /compact returns no override", async () => {
    const result = await resolveSlash("/compact");
    expect(result).toEqual({ kind: "compact" });
  });

  test("/compact <integer> sets explicit token target", async () => {
    const result = await resolveSlash("/compact 30000");
    expect(result).toEqual({
      kind: "compact",
      targetInputTokensOverride: 30000,
    });
  });

  test("/compact <n>k expands to thousands", async () => {
    const result = await resolveSlash("/compact 30k");
    expect(result).toEqual({
      kind: "compact",
      targetInputTokensOverride: 30_000,
    });
  });

  test("/compact <n>m expands to millions", async () => {
    const result = await resolveSlash("/compact 1.5M");
    expect(result).toEqual({
      kind: "compact",
      targetInputTokensOverride: 1_500_000,
    });
  });

  test("/compact rejects malformed args with usage hint", async () => {
    const result = await resolveSlash("/compact bogus");
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("expected unknown");
    expect(result.message).toContain("`bogus`");
    expect(result.message).toContain("/compact");
  });

  test("/compact rejects zero", async () => {
    const result = await resolveSlash("/compact 0");
    expect(result.kind).toBe("unknown");
  });

  test("/compact rejects negative numbers", async () => {
    const result = await resolveSlash("/compact -50");
    expect(result.kind).toBe("unknown");
  });
});

describe("classifySlash is a pure classifier matching resolveSlash kinds", () => {
  // Lookahead in `buildPassthroughBatch` must not run `resolveSlash`'s side
  // effects. The pure classifier is synchronous, takes no side-effecting
  // dependencies, and must agree with resolveSlash's `kind`.
  const cases: Array<{
    input: string;
    kind: "passthrough" | "compact" | "unknown";
  }> = [
    { input: "/models", kind: "unknown" },
    { input: "/context", kind: "unknown" },
    { input: "/status", kind: "unknown" },
    { input: "/commands", kind: "unknown" },
    { input: "/compact", kind: "compact" },
    { input: "/compact 30000", kind: "compact" },
    { input: "/compact 30k", kind: "compact" },
    { input: "/compact 1.5M", kind: "compact" },
    { input: "/compact bogus", kind: "unknown" },
    { input: "/model", kind: "unknown" },
    { input: "/model foo", kind: "unknown" },
    { input: "/opus", kind: "unknown" },
    { input: "hello", kind: "passthrough" },
    { input: "  /compact  ", kind: "compact" },
    { input: "  /compact 50k  ", kind: "compact" },
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
