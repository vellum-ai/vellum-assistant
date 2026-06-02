import { describe, expect, mock, test } from "bun:test";

// Mock conversation-crud so getConversationOverrideProfile is deterministic.
// By default the inherited profile is undefined; tests that exercise
// inheritance supply context.overrideProfile, which spawn.ts prefers over
// the row read.
mock.module("../../memory/conversation-crud.js", () => ({
  getConversationOverrideProfile: () => undefined,
}));

import { getSubagentManager } from "../../subagent/index.js";
import type { ToolContext } from "../types.js";
import { executeSubagentSpawn } from "./spawn.js";

function makeContext(
  conversationId: string,
  extras: Record<string, unknown> = {},
): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId,
    trustClass: "guardian" as const,
    sendToClient: () => {},
    ...extras,
  } as unknown as ToolContext;
}

/**
 * Runs executeSubagentSpawn with manager.spawn stubbed and returns the
 * captured config passed to the manager.
 */
async function spawnAndCapture(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  const manager = getSubagentManager();
  const originalSpawn = manager.spawn.bind(manager);

  let capturedConfig: Record<string, unknown> | undefined;
  manager.spawn = async (config: Record<string, unknown>) => {
    capturedConfig = config;
    return "stub-subagent-id";
  };

  try {
    const result = await executeSubagentSpawn(input, context);
    expect(result.isError).toBe(false);
    expect(capturedConfig).toBeDefined();
    return capturedConfig as Record<string, unknown>;
  } finally {
    manager.spawn = originalSpawn;
  }
}

describe("subagent_spawn override_profile", () => {
  test("explicit override_profile is forwarded to manager.spawn", async () => {
    const config = await spawnAndCapture(
      {
        label: "Worker",
        objective: "Write files",
        override_profile: "balanced",
      },
      makeContext("conv-explicit"),
    );

    expect(config.overrideProfile).toBe("balanced");
  });

  test("omitted override_profile falls back to the inherited profile", async () => {
    const config = await spawnAndCapture(
      {
        label: "Worker",
        objective: "Write files",
      },
      makeContext("conv-inherit", { overrideProfile: "quality-optimized" }),
    );

    expect(config.overrideProfile).toBe("quality-optimized");
  });

  test("omitted override_profile with no inheritance omits the field", async () => {
    const config = await spawnAndCapture(
      {
        label: "Worker",
        objective: "Write files",
      },
      makeContext("conv-none"),
    );

    expect(config.overrideProfile).toBeUndefined();
  });

  test("explicit override_profile wins over a non-null inherited profile", async () => {
    const config = await spawnAndCapture(
      {
        label: "Worker",
        objective: "Write files",
        override_profile: "balanced",
      },
      makeContext("conv-override", {
        overrideProfile: "quality-optimized",
      }),
    );

    expect(config.overrideProfile).toBe("balanced");
  });
});
