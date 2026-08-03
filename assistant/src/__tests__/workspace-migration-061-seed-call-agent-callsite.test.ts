import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { LLMSchema } from "../config/schemas/llm.js";
import { seedCallAgentCallsiteMigration } from "../workspace/migrations/061-seed-call-agent-callsite.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-061-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function configPath(): string {
  return join(workspaceDir, "config.json");
}

beforeEach(() => {
  freshWorkspace();
  delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
});

afterEach(() => {
  delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("061-seed-call-agent-callsite migration", () => {
  test("has correct migration id", () => {
    expect(seedCallAgentCallsiteMigration.id).toBe(
      "061-seed-call-agent-callsite",
    );
  });

  test("seeds low effort + disabled thinking without touching model", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });

    seedCallAgentCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.callAgent).toEqual({
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("fills in missing effort and thinking when only model is set (post-038 state)", () => {
    // Migration 038 may have seeded `{ model: "..." }` from legacy
    // `calls.model`. That leaves `effort` + `thinking` falling through to
    // `llm.default` — the bug this migration fixes.
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          callAgent: { model: "gpt-5.4-nano" },
        },
      },
    });

    seedCallAgentCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.callAgent).toEqual({
      model: "gpt-5.4-nano",
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("preserves user-set effort and thinking values", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          callAgent: {
            model: "claude-opus-4-7",
            effort: "high",
            thinking: { enabled: true },
          },
        },
      },
    });

    seedCallAgentCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.callAgent).toEqual({
      model: "claude-opus-4-7",
      effort: "high",
      thinking: { enabled: true },
    });
  });

  test("runs regardless of configured provider (no model is chosen by this migration)", () => {
    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4" },
      },
    });

    seedCallAgentCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.callAgent).toEqual({
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("skips when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedCallAgentCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("runs on fresh install (no config.json) and writes starter config", () => {
    expect(existsSync(configPath())).toBe(false);

    seedCallAgentCallsiteMigration.run(workspaceDir);

    expect(existsSync(configPath())).toBe(true);
    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.callAgent).toEqual({
      effort: "low",
      thinking: { enabled: false },
    });
  });

  test("is idempotent — a second run is a no-op", () => {
    writeConfig({
      llm: { default: { provider: "anthropic" } },
    });

    seedCallAgentCallsiteMigration.run(workspaceDir);
    const afterFirst = readFileSync(configPath(), "utf-8");
    seedCallAgentCallsiteMigration.run(workspaceDir);
    const afterSecond = readFileSync(configPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });

  test("does not clobber unrelated call-site entries", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        callSites: {
          interactionClassifier: { model: "claude-haiku-4-5-20251001" },
        },
      },
    });

    seedCallAgentCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.interactionClassifier).toEqual({
      model: "claude-haiku-4-5-20251001",
    });
    expect(config.llm.callSites.callAgent).toBeDefined();
  });

  test("resolved callAgent config has thinking disabled and non-max effort, model unchanged", () => {
    // End-to-end check: after the migration runs, parsing the seeded config
    // through `LLMSchema` and resolving the `callAgent` call site must
    // produce a config with thinking disabled and non-max effort, while the
    // model still falls through to `llm.default.model` untouched. This is
    // the invariant the JARVIS-1400 fix depends on — any regression that
    // leaks `effort: "max"` or `thinking.enabled: true` into the resolved
    // voice/phone config revives the slow time-to-first-token bug.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });

    seedCallAgentCallsiteMigration.run(workspaceDir);

    const onDisk = readConfig() as { llm: unknown };
    const parsed = LLMSchema.parse(onDisk.llm);
    const resolved = resolveCallSiteConfig("callAgent", parsed);
    expect(resolved.thinking.enabled).toBe(false);
    expect(resolved.effort).not.toBe("max");
    expect(resolved.effort).toBe("low");
    expect(resolved.model).toBe("claude-opus-4-7");
  });
});
