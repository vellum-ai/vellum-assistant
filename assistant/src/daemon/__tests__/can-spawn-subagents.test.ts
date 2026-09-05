/**
 * `canSpawnSubagentsForTurn` reads the turn's resolved tool surface, which is
 * what gates the parallel-delegation system-prompt section. A turn that cannot
 * reach the spawn tool must not be told to hand work to subagents.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import * as configLoader from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import type { Conversation } from "../conversation.js";
import { canSpawnSubagentsForTurn } from "../conversation-tool-setup.js";

let getConfigSpy: ReturnType<typeof spyOn> | undefined;

function withExclude(exclude: string[]): void {
  const stub: Partial<AssistantConfig> = { tools: { exclude } };
  getConfigSpy = spyOn(configLoader, "getConfig").mockReturnValue(
    stub as AssistantConfig,
  );
}

function ctx(overrides: Partial<Conversation> = {}): Conversation {
  return {
    toolsDisabledDepth: 0,
    hasNoClient: false,
    ...overrides,
  } as unknown as Conversation;
}

afterEach(() => {
  getConfigSpy?.mockRestore();
  getConfigSpy = undefined;
});

describe("canSpawnSubagentsForTurn", () => {
  test("an ordinary turn can spawn", () => {
    withExclude([]);
    expect(canSpawnSubagentsForTurn(ctx())).toBe(true);
  });

  test("a workspace tools.exclude entry for the spawn tool answers no", () => {
    withExclude(["subagent_spawn"]);
    expect(canSpawnSubagentsForTurn(ctx())).toBe(false);
  });

  test("excluding the skill loader alone still leaves the spawn tool reachable", () => {
    withExclude(["skill_load"]);
    expect(canSpawnSubagentsForTurn(ctx())).toBe(true);
  });

  test("a turn with tools disabled answers no", () => {
    withExclude([]);
    expect(canSpawnSubagentsForTurn(ctx({ toolsDisabledDepth: 1 }))).toBe(
      false,
    );
  });

  test("a wire-scoped background run whose allowlist omits both answers no", () => {
    withExclude([]);
    expect(
      canSpawnSubagentsForTurn(
        ctx({ subagentAllowedTools: new Set(["file_read", "web_search"]) }),
      ),
    ).toBe(false);
  });

  test("a background run that allowlists the spawn tool can spawn", () => {
    withExclude([]);
    expect(
      canSpawnSubagentsForTurn(
        ctx({ subagentAllowedTools: new Set(["subagent_spawn"]) }),
      ),
    ).toBe(true);
  });
});
