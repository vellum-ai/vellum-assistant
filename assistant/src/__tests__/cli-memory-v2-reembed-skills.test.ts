/**
 * Tests for the `memory v2 reembed-skills` end-to-end pair: the CLI
 * subcommand and the matching `memory_v2_reembed_skills` IPC route.
 *
 * The CLI half mocks `cliIpcCall` and asserts the subcommand dispatches
 * to `memory_v2_reembed_skills` with an empty body. The route half uses
 * the real `loadConfig` + flag resolver — flags are toggled via
 * `_setOverridesForTesting` and `memory.v2.enabled` is toggled via a
 * per-test `config.json` fixture in the temp workspace. We mock only
 * `seedV2SkillEntries` so we can assert it was invoked without actually
 * embedding skills.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Command } from "commander";

import {
  _setOverridesForTesting,
  clearFeatureFlagOverridesCache,
} from "../config/assistant-feature-flags.js";
import { invalidateConfigCache } from "../config/loader.js";
import { getWorkspaceDir } from "../util/platform.js";

// ---------------------------------------------------------------------------
// Module-level mocks — kept minimal. `loadConfig`,
// `isAssistantFeatureFlagEnabled`, and `getLogger` use their real
// implementations because we already have first-class test hooks
// (`_setOverridesForTesting` for flags, a per-test workspace `config.json`
// for config) that exercise the same code paths the route handler runs in
// production.
// ---------------------------------------------------------------------------

let lastIpcCall: { method: string; params?: Record<string, unknown> } | null =
  null;
let mockIpcResult: { ok: boolean; result?: unknown; error?: string } = {
  ok: true,
  result: { success: true },
};

mock.module("../ipc/cli-client.js", () => ({
  cliIpcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return mockIpcResult;
  },
}));

let seedCallCount = 0;
mock.module("../memory/v2/skill-store.js", () => ({
  seedV2SkillEntries: async () => {
    seedCallCount += 1;
  },
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

const { registerMemoryV2Command } =
  await import("../cli/commands/memory-v2.js");
const { ROUTES: memoryV2Routes, MEMORY_V2_DISABLED_CODE } =
  await import("../runtime/routes/memory-v2-routes.js");
const { RouteError } = await import("../runtime/routes/errors.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProgramWithStubParent(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
    writeOut: () => {},
  });
  program.command("memory").description("Stub parent for tests");
  registerMemoryV2Command(program);
  return program;
}

async function runCommand(args: string[]): Promise<{ exitCode: number }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;

  process.exitCode = 0;
  try {
    const program = buildProgramWithStubParent();
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  return { exitCode };
}

/**
 * Override `memory.v2.enabled` (and any other config paths) by writing a
 * workspace `config.json` that the real `loadConfig` will pick up.
 */
function writeWorkspaceConfig(json: Record<string, unknown>): void {
  const workspace = getWorkspaceDir();
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify(json, null, 2),
    "utf-8",
  );
  invalidateConfigCache();
}

const reembedSkillsRoute = memoryV2Routes.find(
  (r) => r.operationId === "memory_v2_reembed_skills",
);

beforeEach(() => {
  lastIpcCall = null;
  mockIpcResult = { ok: true, result: { success: true } };
  seedCallCount = 0;
  process.exitCode = 0;

  // Real flag + config defaults: enable both so happy-path tests pass.
  _setOverridesForTesting({ "memory-v2-enabled": true });
  writeWorkspaceConfig({ memory: { v2: { enabled: true } } });
});

afterEach(() => {
  // Roll back the workspace config + flag overrides between cases so a
  // gate-off test does not leak into the next case's setup.
  rmSync(join(getWorkspaceDir(), "config.json"), { force: true });
  invalidateConfigCache();
  clearFeatureFlagOverridesCache();
});

// ---------------------------------------------------------------------------
// CLI subcommand
// ---------------------------------------------------------------------------

describe("memory v2 reembed-skills CLI", () => {
  test("dispatches to memory_v2_reembed_skills with empty body", async () => {
    const { exitCode } = await runCommand(["memory", "v2", "reembed-skills"]);

    expect(exitCode).toBe(0);
    expect(lastIpcCall).not.toBeNull();
    expect(lastIpcCall!.method).toBe("memory_v2_reembed_skills");
    expect(lastIpcCall!.params).toEqual({ body: {} });
  });

  test("exits with code 1 on IPC failure", async () => {
    mockIpcResult = { ok: false, error: "Daemon not running" };

    const { exitCode } = await runCommand(["memory", "v2", "reembed-skills"]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// IPC route handler
// ---------------------------------------------------------------------------

describe("memory_v2_reembed_skills route", () => {
  test("registers under operationId 'memory_v2_reembed_skills'", () => {
    expect(reembedSkillsRoute).toBeDefined();
    expect(reembedSkillsRoute!.operationId).toBe("memory_v2_reembed_skills");
  });

  test("calls seedV2SkillEntries once and returns success", async () => {
    const result = await reembedSkillsRoute!.handler({ body: {} });

    expect(seedCallCount).toBe(1);
    expect(result).toEqual({ success: true });
  });

  test("rejects unknown params", async () => {
    await expect(
      reembedSkillsRoute!.handler({ body: { extra: 1 } }),
    ).rejects.toThrow();
    expect(seedCallCount).toBe(0);
  });

  test("throws RouteError when feature flag is off", async () => {
    _setOverridesForTesting({ "memory-v2-enabled": false });

    await expect(
      reembedSkillsRoute!.handler({ body: {} }),
    ).rejects.toBeInstanceOf(RouteError);
    expect(seedCallCount).toBe(0);
  });

  test("throws RouteError when config.memory.v2.enabled is off", async () => {
    writeWorkspaceConfig({ memory: { v2: { enabled: false } } });

    await expect(
      reembedSkillsRoute!.handler({ body: {} }),
    ).rejects.toBeInstanceOf(RouteError);
    expect(seedCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// All v2 routes share the same gate
// ---------------------------------------------------------------------------

describe("all memory v2 routes — MEMORY_V2_DISABLED gate", () => {
  // Minimal bodies that satisfy each route's schema. The gate runs before
  // schema validation so any body would surface the gate error, but using
  // valid shapes keeps the assertion precise: we're confirming the gate
  // (not zod) is what blocks the call.
  const MINIMAL_BODIES: Record<string, Record<string, unknown>> = {
    memory_v2_backfill: { op: "migrate" },
    memory_v2_validate: {},
    memory_v2_get_concept_page: { slug: "any" },
    memory_v2_list_concept_pages: {},
    memory_v2_rebuild_corpus_stats: {},
    memory_v2_explain_similarity: { userText: "hello" },
    memory_v2_concept_frequency: {},
    memory_v2_fit_anisotropy: {},
  };

  const GATE_OFF_CASES = [
    {
      label: "feature flag is off",
      apply: () => _setOverridesForTesting({ "memory-v2-enabled": false }),
    },
    {
      label: "config is off",
      apply: () => writeWorkspaceConfig({ memory: { v2: { enabled: false } } }),
    },
  ];

  for (const [operationId, body] of Object.entries(MINIMAL_BODIES)) {
    for (const { label, apply } of GATE_OFF_CASES) {
      test(`${operationId} throws MEMORY_V2_DISABLED when ${label}`, async () => {
        apply();
        const route = memoryV2Routes.find((r) => r.operationId === operationId);
        expect(route).toBeDefined();

        try {
          await route!.handler({ body });
          throw new Error("expected handler to throw");
        } catch (err) {
          expect(err).toBeInstanceOf(RouteError);
          expect((err as InstanceType<typeof RouteError>).code).toBe(
            MEMORY_V2_DISABLED_CODE,
          );
        }
      });
    }
  }
});
