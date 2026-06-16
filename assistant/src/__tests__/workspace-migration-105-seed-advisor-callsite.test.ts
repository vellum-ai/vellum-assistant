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
import { seedAdvisorCallsiteMigration } from "../workspace/migrations/105-seed-advisor-callsite.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-105-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("105-seed-advisor-callsite migration", () => {
  test("has correct migration id", () => {
    expect(seedAdvisorCallsiteMigration.id).toBe("105-seed-advisor-callsite");
  });

  test("seeds callSites.advisor when an advisor profile with a model exists", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          advisor: {
            provider: "anthropic",
            model: "claude-opus-4-8",
            maxTokens: 2048,
          },
        },
      },
    });

    seedAdvisorCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.advisor).toEqual({ profile: "advisor" });
  });

  test("preserves an existing callSites.advisor unchanged", () => {
    const userAdvisor = {
      provider: "openai",
      model: "gpt-5.4",
      maxTokens: 4096,
      effort: "medium",
    };
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          advisor: {
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
        callSites: {
          advisor: userAdvisor,
        },
      },
    });

    seedAdvisorCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.advisor).toEqual(userAdvisor);
  });

  test("no-op when no advisor profile is present", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet-4-7",
          },
        },
      },
    });

    seedAdvisorCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("no-op when the advisor profile lacks a model (empty shell)", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          advisor: {},
        },
      },
    });

    seedAdvisorCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("skips when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          advisor: {
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
        },
      },
    });

    seedAdvisorCallsiteMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites?: Record<string, unknown> };
    };
    expect(config.llm.callSites).toBeUndefined();
  });

  test("resolved advisor config pins the advisor profile under overrideProfile", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          advisor: {
            provider: "anthropic",
            model: "claude-opus-4-8",
            maxTokens: 2048,
          },
          balanced: {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
          },
        },
        activeProfile: "balanced",
      },
    });

    seedAdvisorCallsiteMigration.run(workspaceDir);

    const onDisk = readConfig() as { llm: unknown };
    const parsed = LLMSchema.parse(onDisk.llm);
    expect(resolveCallSiteConfig("advisor", parsed).model).toBe(
      "claude-opus-4-8",
    );
    expect(
      resolveCallSiteConfig("advisor", parsed, { overrideProfile: "balanced" })
        .model,
    ).toBe("claude-opus-4-8");
  });
});
