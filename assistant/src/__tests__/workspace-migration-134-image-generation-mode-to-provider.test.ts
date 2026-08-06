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
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { getLastWorkspaceMigrationId } from "../workspace/migrations/runner.js";

// Migration files expose no API to other code (see migrations AGENTS.md);
// the registry is the one sanctioned importer, so the test exercises the
// registered entry rather than importing the module directly.
const imageGenerationModeToProviderMigration = WORKSPACE_MIGRATIONS.find(
  (m) => m.id === "134-image-generation-mode-to-provider",
);
if (!imageGenerationModeToProviderMigration) {
  throw new Error("migration 134 is not registered in WORKSPACE_MIGRATIONS");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-134-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function imageGen(config: Record<string, unknown>): Record<string, any> {
  return (config.services as Record<string, any>)["image-generation"];
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

describe("134-image-generation-mode-to-provider", () => {
  // getLastWorkspaceMigrationId() reports the final array entry as the
  // registry ceiling to the identity and rollback routes, so the
  // highest-numbered migration must sit last in the registry.
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

  test("rewrites a managed gemini service to provider vellum, model preserved", () => {
    writeConfig({
      services: {
        "image-generation": {
          mode: "managed",
          provider: "gemini",
          model: "gemini-3-pro-image-preview",
        },
      },
    });

    imageGenerationModeToProviderMigration.run(workspaceDir);

    expect(imageGen(readConfig())).toEqual({
      provider: "vellum",
      model: "gemini-3-pro-image-preview",
    });
  });

  // Managed OpenAI has no exemption: the backend derives from the model
  // prefix at request time, so a managed gpt-image-2 user keeps routing to
  // the OpenAI proxy through provider vellum.
  test("rewrites a managed openai service to provider vellum, model preserved", () => {
    writeConfig({
      services: {
        "image-generation": {
          mode: "managed",
          provider: "openai",
          model: "gpt-image-2",
        },
      },
    });

    imageGenerationModeToProviderMigration.run(workspaceDir);

    expect(imageGen(readConfig())).toEqual({
      provider: "vellum",
      model: "gpt-image-2",
    });
  });

  test("keeps the BYOK provider and drops mode for your-own", () => {
    writeConfig({
      services: {
        "image-generation": {
          mode: "your-own",
          provider: "gemini",
          model: "gemini-3.1-flash-image-preview",
        },
      },
    });

    imageGenerationModeToProviderMigration.run(workspaceDir);

    expect(imageGen(readConfig())).toEqual({
      provider: "gemini",
      model: "gemini-3.1-flash-image-preview",
    });
  });

  test("pins the gemini default for your-own with no persisted provider", () => {
    // With `mode` gone, an absent provider leaf would be context-filled to
    // "vellum" on platform deployments — a silent your-own -> managed flip.
    writeConfig({
      services: { "image-generation": { mode: "your-own" } },
    });

    imageGenerationModeToProviderMigration.run(workspaceDir);

    expect(imageGen(readConfig())).toEqual({ provider: "gemini" });
  });

  test("is idempotent", () => {
    writeConfig({
      services: {
        "image-generation": {
          mode: "managed",
          provider: "gemini",
          model: "gpt-image-2",
        },
      },
    });

    imageGenerationModeToProviderMigration.run(workspaceDir);
    const once = readConfig();
    imageGenerationModeToProviderMigration.run(workspaceDir);

    expect(readConfig()).toEqual(once);
  });

  test("leaves configs without an image-generation mode alone", () => {
    const original = {
      services: {
        "image-generation": { provider: "vellum", model: "gpt-image-2" },
        "google-oauth": { mode: "managed" },
      },
    };
    writeConfig(original);

    imageGenerationModeToProviderMigration.run(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  test("survives a missing config and malformed JSON", () => {
    expect(() =>
      imageGenerationModeToProviderMigration.run(workspaceDir),
    ).not.toThrow();

    writeFileSync(join(workspaceDir, "config.json"), "{ not json");
    expect(() =>
      imageGenerationModeToProviderMigration.run(workspaceDir),
    ).not.toThrow();
  });

  // The migrated shape is what the daemon actually parses, so a managed user
  // must land on vellum with their model intact rather than falling back to
  // a keyless BYOK provider.
  test("migrated output parses to the vellum provider", () => {
    writeConfig({
      services: {
        "image-generation": {
          mode: "managed",
          provider: "openai",
          model: "gpt-image-2",
        },
      },
    });

    imageGenerationModeToProviderMigration.run(workspaceDir);
    const parsed = AssistantConfigSchema.parse(readConfig());

    expect(parsed.services["image-generation"].provider).toBe("vellum");
    expect(parsed.services["image-generation"].model).toBe("gpt-image-2");
  });

  describe("down", () => {
    test("round-trip restores the managed pair", () => {
      writeConfig({
        services: {
          "image-generation": {
            mode: "managed",
            provider: "gemini",
            model: "gemini-3-pro-image-preview",
          },
        },
      });

      imageGenerationModeToProviderMigration.run(workspaceDir);
      imageGenerationModeToProviderMigration.down!(workspaceDir);

      // The pre-migration backend provider (gemini) is not recoverable — it
      // was overwritten with vellum on the way up and re-derives from the
      // model prefix on the next model write.
      expect(imageGen(readConfig())).toEqual({
        mode: "managed",
        provider: "vellum",
        model: "gemini-3-pro-image-preview",
      });
    });

    test("restores your-own for a BYOK provider", () => {
      writeConfig({
        services: {
          "image-generation": {
            provider: "gemini",
            model: "gemini-3.1-flash-image-preview",
          },
        },
      });

      imageGenerationModeToProviderMigration.down!(workspaceDir);

      expect(imageGen(readConfig())).toEqual({
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      });
    });

    test("does not re-add mode when it is already present", () => {
      writeConfig({
        services: {
          "image-generation": { mode: "your-own", provider: "gemini" },
        },
      });

      imageGenerationModeToProviderMigration.down!(workspaceDir);

      expect(imageGen(readConfig())).toEqual({
        mode: "your-own",
        provider: "gemini",
      });
    });
  });
});
