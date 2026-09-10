/**
 * `canSpawnSubagentsForTurn` reads the turn's resolved tool surface, which is
 * one of the two inputs gating the parallel-delegation system-prompt section.
 * A turn that cannot reach the spawn tool must not be told to hand work to
 * subagents, and reaching it means the whole dispatch path: `skill_load`
 * activates the bundled `subagent` skill and `skill_execute` dispatches to
 * `subagent_spawn` inside it, so the bare spawn name alone is not a path.
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

  test("a workspace tools.exclude entry on any step of the path answers no", () => {
    for (const name of ["subagent_spawn", "skill_execute", "skill_load"]) {
      withExclude([name]);
      expect(canSpawnSubagentsForTurn(ctx())).toBe(false);
      getConfigSpy?.mockRestore();
      getConfigSpy = undefined;
    }
  });

  test("a turn with tools disabled answers no", () => {
    withExclude([]);
    expect(canSpawnSubagentsForTurn(ctx({ toolsDisabledDepth: 1 }))).toBe(
      false,
    );
  });

  test("a disk-pressure cleanup turn answers no", () => {
    // Cleanup mode narrows the surface to `DISK_PRESSURE_CLEANUP_TOOL_NAMES`,
    // which carries `skill_load` but neither the dispatcher nor the spawn tool.
    withExclude([]);
    expect(
      canSpawnSubagentsForTurn(ctx({ diskPressureCleanupModeActive: true })),
    ).toBe(false);
  });

  test("a wire-scoped background run whose allowlist omits the path answers no", () => {
    withExclude([]);
    expect(
      canSpawnSubagentsForTurn(
        ctx({ subagentAllowedTools: new Set(["file_read", "web_search"]) }),
      ),
    ).toBe(false);
  });

  test("an allowlist naming only the spawn tool answers no", () => {
    // The spawn tool is never called by name: without the dispatcher there is
    // no callable path to it, so the turn must not be told to delegate.
    withExclude([]);
    expect(
      canSpawnSubagentsForTurn(
        ctx({ subagentAllowedTools: new Set(["subagent_spawn"]) }),
      ),
    ).toBe(false);
  });

  test("an allowlist naming only the skill loader answers no", () => {
    withExclude([]);
    expect(
      canSpawnSubagentsForTurn(
        ctx({ subagentAllowedTools: new Set(["skill_load"]) }),
      ),
    ).toBe(false);
  });

  test("a background run that allowlists the whole path can spawn", () => {
    withExclude([]);
    expect(
      canSpawnSubagentsForTurn(
        ctx({
          subagentAllowedTools: new Set([
            "skill_load",
            "skill_execute",
            "subagent_spawn",
          ]),
        }),
      ),
    ).toBe(true);
  });
});

describe("an execution-gated wake's allowlist", () => {
  /**
   * `isToolActiveForContext` skips the allowlist in execution mode by design:
   * that mode keeps the full surface on the wire for provider-cache parity and
   * rejects the call in the executor instead. The delegation gate is asking a
   * different question, so it checks the allowlist itself.
   */
  test("the memory retrospective's shape cannot spawn", () => {
    withExclude([]);
    expect(
      canSpawnSubagentsForTurn(
        ctx({
          subagentToolGateMode: "execution",
          // The wake's real list: `skill_load` is on it, the dispatcher and the
          // spawn tool are not, so a spawn is denied at execution.
          subagentAllowedTools: new Set([
            "remember",
            "scaffold_managed_skill",
            "skill_load",
            "find_similar_skills",
          ]),
        }),
      ),
    ).toBe(false);
  });

  test("a remember-only execution-mode wake cannot spawn", () => {
    withExclude([]);
    expect(
      canSpawnSubagentsForTurn(
        ctx({
          subagentToolGateMode: "execution",
          subagentAllowedTools: new Set(["remember"]),
        }),
      ),
    ).toBe(false);
  });

  test("an execution-mode allowlist naming the whole path can spawn", () => {
    withExclude([]);
    expect(
      canSpawnSubagentsForTurn(
        ctx({
          subagentToolGateMode: "execution",
          subagentAllowedTools: new Set([
            "skill_load",
            "skill_execute",
            "subagent_spawn",
          ]),
        }),
      ),
    ).toBe(true);
  });
});
