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

import { repairRecallCallsiteEmptyProfileMigration } from "../workspace/migrations/073-repair-recall-callsite-empty-profile.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-073-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("073-repair-recall-callsite-empty-profile migration", () => {
  test("has correct migration id", () => {
    expect(repairRecallCallsiteEmptyProfileMigration.id).toBe(
      "073-repair-recall-callsite-empty-profile",
    );
  });

  test("rewrites empty-profile recall to use cheap model on anthropic workspace", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: { "cost-optimized": {} },
        callSites: { recall: { profile: "cost-optimized" } },
      },
    });

    repairRecallCallsiteEmptyProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.recall).toEqual({
      model: "claude-haiku-4-5-20251001",
    });
  });

  test("preserves existing user-defined recall.model override", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: { "cost-optimized": {} },
        callSites: {
          recall: {
            profile: "cost-optimized",
            model: "claude-opus-4-7",
          },
        },
      },
    });

    repairRecallCallsiteEmptyProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    // Broken profile pointer is removed, but user's model value is preserved.
    expect(config.llm.callSites.recall).toEqual({
      model: "claude-opus-4-7",
    });
  });

  test("leaves recall alone when cost-optimized profile has a real model", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: {
          "cost-optimized": { model: "claude-haiku-4-5-20251001" },
        },
        callSites: { recall: { profile: "cost-optimized" } },
      },
    });

    repairRecallCallsiteEmptyProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.recall).toEqual({ profile: "cost-optimized" });
  });

  test("uses provider-appropriate cheap model for openrouter", () => {
    writeConfig({
      llm: {
        default: { provider: "openrouter" },
        profiles: { "cost-optimized": {} },
        callSites: { recall: { profile: "cost-optimized" } },
      },
    });

    repairRecallCallsiteEmptyProfileMigration.run(workspaceDir);

    const config = readConfig() as {
      llm: { callSites: Record<string, Record<string, unknown>> };
    };
    expect(config.llm.callSites.recall).toEqual({
      model: "anthropic/claude-haiku-4.5",
    });
  });

  test("is idempotent — second run is a no-op", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic" },
        profiles: { "cost-optimized": {} },
        callSites: { recall: { profile: "cost-optimized" } },
      },
    });

    repairRecallCallsiteEmptyProfileMigration.run(workspaceDir);
    const afterFirst = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    repairRecallCallsiteEmptyProfileMigration.run(workspaceDir);
    const afterSecond = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );

    expect(afterSecond).toBe(afterFirst);
  });
});
