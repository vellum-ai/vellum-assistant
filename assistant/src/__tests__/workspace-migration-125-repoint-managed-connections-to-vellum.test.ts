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

import { repointManagedConnectionsToVellumMigration } from "../workspace/migrations/125-repoint-managed-connections-to-vellum.js";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function readLlm(): Record<string, unknown> {
  return readConfig().llm as Record<string, unknown>;
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-125-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("125-repoint-managed-connections-to-vellum migration", () => {
  test("no-op when config.json does not exist", () => {
    repointManagedConnectionsToVellumMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    repointManagedConnectionsToVellumMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("repoints legacy managed connections across default, profiles, and callSites", () => {
    writeConfig({
      llm: {
        default: {
          provider: "anthropic",
          provider_connection: "anthropic-managed",
        },
        profiles: {
          balanced: {
            source: "managed",
            provider: "fireworks",
            provider_connection: "fireworks-managed",
          },
          "quality-optimized": {
            source: "managed",
            provider: "anthropic",
            provider_connection: "anthropic-managed",
          },
          "os-beta": {
            source: "managed",
            provider: "together",
            provider_connection: "together-managed",
          },
          // User-owned copy referencing a managed connection is repointed too.
          "my-quality": {
            source: "user",
            provider: "openai",
            provider_connection: "openai-managed",
          },
        },
        callSites: {
          replySuggestion: {
            provider: "gemini",
            provider_connection: "gemini-managed",
          },
        },
      },
    });

    repointManagedConnectionsToVellumMigration.run(workspaceDir);

    const llm = readLlm();
    const profiles = llm.profiles as Record<string, Record<string, unknown>>;
    const callSites = llm.callSites as Record<string, Record<string, unknown>>;

    expect((llm.default as Record<string, unknown>).provider_connection).toBe(
      "vellum",
    );
    expect(profiles.balanced.provider_connection).toBe("vellum");
    expect(profiles["quality-optimized"].provider_connection).toBe("vellum");
    expect(profiles["os-beta"].provider_connection).toBe("vellum");
    expect(profiles["my-quality"].provider_connection).toBe("vellum");
    expect(callSites.replySuggestion.provider_connection).toBe("vellum");

    // The provider field is left intact — that is how vellum recovers the
    // upstream at dispatch time.
    expect(profiles.balanced.provider).toBe("fireworks");
    expect(profiles["quality-optimized"].provider).toBe("anthropic");
  });

  test("leaves non-managed connections (personal, openrouter) untouched", () => {
    const original = {
      llm: {
        profiles: {
          "custom-balanced": {
            source: "user",
            provider: "anthropic",
            provider_connection: "anthropic-personal",
          },
          "my-router": {
            source: "user",
            provider: "openrouter",
            provider_connection: "openrouter-personal",
          },
        },
      },
    };
    writeConfig(original);
    repointManagedConnectionsToVellumMigration.run(workspaceDir);
    expect(readConfig()).toEqual(original);
  });
});
