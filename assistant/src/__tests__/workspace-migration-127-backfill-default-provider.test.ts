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

import { backfillDefaultProviderMigration } from "../workspace/migrations/127-backfill-default-provider.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-127-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function defaultProvider(): unknown {
  return (readConfig().llm as Record<string, unknown>).defaultProvider;
}

let originalIsPlatform: string | undefined;

beforeEach(() => {
  freshWorkspace();
  originalIsPlatform = process.env.IS_PLATFORM;
  delete process.env.IS_PLATFORM;
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
  if (originalIsPlatform === undefined) {
    delete process.env.IS_PLATFORM;
  } else {
    process.env.IS_PLATFORM = originalIsPlatform;
  }
});

describe("127-backfill-default-provider", () => {
  test("backfills from llm.default.provider", () => {
    writeConfig({ llm: { default: { provider: "gemini" } } });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(defaultProvider()).toEqual({ provider: "gemini" });
  });

  test("backfills from custom-balanced provider", () => {
    writeConfig({
      llm: {
        profiles: {
          "custom-balanced": { source: "user", provider: "openai" },
        },
      },
    });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(defaultProvider()).toEqual({ provider: "openai" });
  });

  test("uses custom-quality-optimized when custom-balanced lacks a provider", () => {
    writeConfig({
      llm: {
        profiles: {
          "custom-balanced": { source: "user" },
          "custom-quality-optimized": { source: "user", provider: "fireworks" },
        },
      },
    });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(defaultProvider()).toEqual({ provider: "fireworks" });
  });

  test("skips an invalid/non-catalog provider signal", () => {
    writeConfig({ llm: { default: { provider: "minimax" } } });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(
      (readConfig().llm as Record<string, unknown>).defaultProvider,
    ).toBeUndefined();
  });

  test("writes nothing when no signals are present", () => {
    writeConfig({ llm: { profiles: {} } });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(
      (readConfig().llm as Record<string, unknown>).defaultProvider,
    ).toBeUndefined();
  });

  test("IS_PLATFORM outranks a legacy provider signal", () => {
    process.env.IS_PLATFORM = "1";
    writeConfig({ llm: { default: { provider: "anthropic" } } });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(defaultProvider()).toEqual({ provider: "vellum" });
  });

  test("IS_PLATFORM backfills vellum with no other signals", () => {
    process.env.IS_PLATFORM = "true";
    writeConfig({ llm: { profiles: {} } });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(defaultProvider()).toEqual({ provider: "vellum" });
  });

  test("IS_PLATFORM never overwrites an existing defaultProvider value", () => {
    process.env.IS_PLATFORM = "1";
    writeConfig({
      llm: { defaultProvider: { provider: "anthropic" } },
    });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(defaultProvider()).toEqual({ provider: "anthropic" });
  });

  test("never overwrites an existing defaultProvider value", () => {
    writeConfig({
      llm: {
        default: { provider: "gemini" },
        defaultProvider: { provider: "anthropic" },
      },
    });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(defaultProvider()).toEqual({ provider: "anthropic" });
  });

  test("repairs an invalid defaultProvider object from signals", () => {
    writeConfig({
      llm: {
        default: { provider: "gemini" },
        defaultProvider: { provider: "not-a-provider" },
      },
    });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(defaultProvider()).toEqual({ provider: "gemini" });
  });

  test("an empty connectionName invalidates the persisted object", () => {
    process.env.IS_PLATFORM = "1";
    writeConfig({
      llm: {
        defaultProvider: { provider: "anthropic", connectionName: "" },
      },
    });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(defaultProvider()).toEqual({ provider: "vellum" });
  });

  test("a valid object with a connectionName is left untouched", () => {
    writeConfig({
      llm: {
        default: { provider: "gemini" },
        defaultProvider: {
          provider: "openai",
          connectionName: "openai-personal",
        },
      },
    });

    backfillDefaultProviderMigration.run(workspaceDir);

    expect(defaultProvider()).toEqual({
      provider: "openai",
      connectionName: "openai-personal",
    });
  });

  test("tolerates malformed config shapes without throwing", () => {
    expect(() =>
      backfillDefaultProviderMigration.run(workspaceDir),
    ).not.toThrow();
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);

    writeConfig({ llm: "not-an-object" });
    expect(() =>
      backfillDefaultProviderMigration.run(workspaceDir),
    ).not.toThrow();

    writeFileSync(join(workspaceDir, "config.json"), "not valid json {{{");
    expect(() =>
      backfillDefaultProviderMigration.run(workspaceDir),
    ).not.toThrow();

    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2]));
    expect(() =>
      backfillDefaultProviderMigration.run(workspaceDir),
    ).not.toThrow();
  });

  describe("legacy anthropic schema-default echo", () => {
    test("legacy anthropic alone produces no write", () => {
      writeConfig({ llm: { default: { provider: "anthropic" } } });

      backfillDefaultProviderMigration.run(workspaceDir);

      expect(
        (readConfig().llm as Record<string, unknown>).defaultProvider,
      ).toBeUndefined();
    });

    test("legacy anthropic defers entirely even with a custom profile", () => {
      writeConfig({
        llm: {
          default: { provider: "anthropic" },
          profiles: {
            "custom-balanced": { source: "user", provider: "openai" },
          },
        },
      });

      backfillDefaultProviderMigration.run(workspaceDir);

      // The migration must not fall through to profiles when legacy is
      // anthropic — it defers the entire resolution to the ensure pass,
      // which checks the vault first.
      expect(
        (readConfig().llm as Record<string, unknown>).defaultProvider,
      ).toBeUndefined();
    });

    test("legacy openai is honored unchanged", () => {
      writeConfig({ llm: { default: { provider: "openai" } } });

      backfillDefaultProviderMigration.run(workspaceDir);

      expect(defaultProvider()).toEqual({ provider: "openai" });
    });

    test("a valid existing defaultProvider is never overwritten by the echo path", () => {
      writeConfig({
        llm: {
          default: { provider: "anthropic" },
          defaultProvider: { provider: "openai" },
        },
      });

      backfillDefaultProviderMigration.run(workspaceDir);

      expect(defaultProvider()).toEqual({ provider: "openai" });
    });
  });
});
