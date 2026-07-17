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

import { AssistantConfigSchema } from "../config/schema.js";
import { speechModeToProviderMigration } from "../workspace/migrations/130-speech-mode-to-provider.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { getLastWorkspaceMigrationId } from "../workspace/migrations/runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-130-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function services(config: Record<string, unknown>): Record<string, any> {
  return config.services as Record<string, any>;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("130-speech-mode-to-provider", () => {
  // This migration's id (130) is below the already-shipped 131, so it must
  // not sit last in the registry: getLastWorkspaceMigrationId() reports the
  // final entry as the registry ceiling to the identity and rollback routes.
  test("the registry ceiling stays at the highest-numbered migration", () => {
    const numericId = (id: string) => Number.parseInt(id, 10);
    const highest = Math.max(
      ...WORKSPACE_MIGRATIONS.map((m) => numericId(m.id)).filter(
        Number.isFinite,
      ),
    );
    const last = getLastWorkspaceMigrationId(WORKSPACE_MIGRATIONS);
    expect(last).not.toBeNull();
    expect(numericId(last!)).toBe(highest);
  });

  test("rewrites a managed service to provider vellum", () => {
    writeConfig({
      services: {
        stt: { mode: "managed", provider: "deepgram", providers: {} },
        tts: { mode: "managed", provider: "elevenlabs" },
      },
    });

    speechModeToProviderMigration.run(workspaceDir);

    const svc = services(readConfig());
    expect(svc.stt).toEqual({ provider: "vellum", providers: {} });
    expect(svc.tts).toEqual({ provider: "vellum" });
  });

  test("keeps the BYOK provider and drops mode for your-own", () => {
    writeConfig({
      services: {
        stt: { mode: "your-own", provider: "openai-whisper" },
        tts: { mode: "your-own", provider: "fish-audio" },
      },
    });

    speechModeToProviderMigration.run(workspaceDir);

    const svc = services(readConfig());
    expect(svc.stt).toEqual({ provider: "openai-whisper" });
    expect(svc.tts).toEqual({ provider: "fish-audio" });
  });

  // The pre-migration schema allowed provider "vellum" alongside mode
  // "managed"; that pair must survive rather than double-rewrite.
  test("preserves an already-vellum managed service", () => {
    writeConfig({ services: { stt: { mode: "managed", provider: "vellum" } } });

    speechModeToProviderMigration.run(workspaceDir);

    expect(services(readConfig()).stt).toEqual({ provider: "vellum" });
  });

  test("is idempotent", () => {
    writeConfig({ services: { stt: { mode: "managed", provider: "deepgram" } } });

    speechModeToProviderMigration.run(workspaceDir);
    const once = readConfig();
    speechModeToProviderMigration.run(workspaceDir);

    expect(readConfig()).toEqual(once);
  });

  test("leaves untouched configs and unrelated keys alone", () => {
    writeConfig({ services: { "web-search": { provider: "brave" } } });

    speechModeToProviderMigration.run(workspaceDir);

    expect(readConfig()).toEqual({
      services: { "web-search": { provider: "brave" } },
    });
  });

  test("survives a missing config and malformed JSON", () => {
    expect(() => speechModeToProviderMigration.run(workspaceDir)).not.toThrow();

    writeFileSync(join(workspaceDir, "config.json"), "{ not json");
    expect(() => speechModeToProviderMigration.run(workspaceDir)).not.toThrow();
  });

  // The migrated shape is what the daemon actually parses, so a managed user
  // must land on vellum rather than falling back to a keyless BYOK provider.
  test("migrated output parses to the vellum provider", () => {
    writeConfig({
      services: {
        stt: { mode: "managed", provider: "deepgram", providers: {} },
        tts: { mode: "managed", provider: "elevenlabs" },
      },
    });

    speechModeToProviderMigration.run(workspaceDir);
    const parsed = AssistantConfigSchema.parse(readConfig());

    expect(parsed.services.stt.provider).toBe("vellum");
    expect(parsed.services.tts.provider).toBe("vellum");
  });

  describe("down", () => {
    test("restores mode from the provider", () => {
      writeConfig({
        services: {
          stt: { provider: "vellum" },
          tts: { provider: "elevenlabs" },
        },
      });

      speechModeToProviderMigration.down(workspaceDir);

      const svc = services(readConfig());
      expect(svc.stt).toEqual({ mode: "managed", provider: "vellum" });
      expect(svc.tts).toEqual({ mode: "your-own", provider: "elevenlabs" });
    });

    test("does not re-add mode when it is already present", () => {
      writeConfig({
        services: { stt: { mode: "your-own", provider: "deepgram" } },
      });

      speechModeToProviderMigration.down(workspaceDir);

      expect(services(readConfig()).stt).toEqual({
        mode: "your-own",
        provider: "deepgram",
      });
    });
  });
});
