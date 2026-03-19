import { describe, expect, test } from "bun:test";

import {
  resolveSlash,
  type SlashContext,
} from "../daemon/conversation-slash.js";

function makeSlashContext(
  overrides: Partial<SlashContext> = {},
): SlashContext {
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
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/pair — Generate pairing info for connecting a mobile device",
    ]);
    expect(lines).not.toContain(
      "/model — Switch the active model",
    );
  });

  test("renders iOS command help without /pair", async () => {
    const lines = await resolveCommandsLines(
      makeSlashContext({ userMessageInterface: "ios" }),
    );
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
    ]);
  });

  test("keeps legacy fallback help when no interface is provided", async () => {
    const lines = await resolveCommandsLines(makeSlashContext());
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/models — List all available models",
      "/pair — Generate pairing info for connecting a mobile device",
      "/status — Show conversation status and context usage",
    ]);
  });

  test("keeps context-free fallback without /status", async () => {
    const lines = await resolveCommandsLines();
    expect(lines).toEqual([
      "/commands — List all available commands",
      "/models — List all available models",
      "/pair — Generate pairing info for connecting a mobile device",
    ]);
  });
});
