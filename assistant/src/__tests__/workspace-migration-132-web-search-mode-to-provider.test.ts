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
const webSearchModeToProviderMigration = WORKSPACE_MIGRATIONS.find(
  (m) => m.id === "132-web-search-mode-to-provider",
);
if (!webSearchModeToProviderMigration) {
  throw new Error("migration 132 is not registered in WORKSPACE_MIGRATIONS");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-132-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function webSearch(config: Record<string, unknown>): Record<string, any> {
  return (config.services as Record<string, any>)["web-search"];
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

describe("132-web-search-mode-to-provider", () => {
  // getLastWorkspaceMigrationId() reports the final array entry as the
  // registry ceiling to the identity and rollback routes, so 132 must be the
  // highest id AND sit last in the registry.
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
    expect(numericId(last!)).toBe(132);
  });

  test("rewrites a managed service to provider vellum", () => {
    writeConfig({
      services: { "web-search": { mode: "managed", provider: "brave" } },
    });

    webSearchModeToProviderMigration.run(workspaceDir);

    expect(webSearch(readConfig())).toEqual({ provider: "vellum" });
  });

  test("keeps the BYOK provider and drops mode for your-own", () => {
    writeConfig({
      services: { "web-search": { mode: "your-own", provider: "firecrawl" } },
    });

    webSearchModeToProviderMigration.run(workspaceDir);

    expect(webSearch(readConfig())).toEqual({ provider: "firecrawl" });
  });

  // The platform default config. Provider Native is a distinct user-facing
  // option (native hosted search with its own managed fallback), so it must
  // survive managed mode verbatim rather than becoming vellum.
  test("preserves inference-provider-native under managed mode", () => {
    writeConfig({
      services: {
        "web-search": {
          mode: "managed",
          provider: "inference-provider-native",
        },
      },
    });

    webSearchModeToProviderMigration.run(workspaceDir);

    expect(webSearch(readConfig())).toEqual({
      provider: "inference-provider-native",
    });
  });

  test("is idempotent", () => {
    writeConfig({
      services: { "web-search": { mode: "managed", provider: "brave" } },
    });

    webSearchModeToProviderMigration.run(workspaceDir);
    const once = readConfig();
    webSearchModeToProviderMigration.run(workspaceDir);

    expect(readConfig()).toEqual(once);
  });

  test("leaves configs without a web-search mode alone", () => {
    const original = {
      services: {
        "web-search": { provider: "perplexity" },
        stt: { mode: "managed", provider: "deepgram" },
      },
    };
    writeConfig(original);

    webSearchModeToProviderMigration.run(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  test("survives a missing config and malformed JSON", () => {
    expect(() =>
      webSearchModeToProviderMigration.run(workspaceDir),
    ).not.toThrow();

    writeFileSync(join(workspaceDir, "config.json"), "{ not json");
    expect(() =>
      webSearchModeToProviderMigration.run(workspaceDir),
    ).not.toThrow();
  });

  // The migrated shape is what the daemon actually parses, so a managed user
  // must land on vellum rather than falling back to a keyless BYOK provider.
  test("migrated output parses to the vellum provider", () => {
    writeConfig({
      services: { "web-search": { mode: "managed", provider: "brave" } },
    });

    webSearchModeToProviderMigration.run(workspaceDir);
    const parsed = AssistantConfigSchema.parse(readConfig());

    expect(parsed.services["web-search"].provider).toBe("vellum");
  });

  describe("down", () => {
    test("round-trip restores the managed pair", () => {
      writeConfig({
        services: { "web-search": { mode: "managed", provider: "brave" } },
      });

      webSearchModeToProviderMigration.run(workspaceDir);
      webSearchModeToProviderMigration.down!(workspaceDir);

      // The pre-migration BYOK provider (brave) is not recoverable — it was
      // overwritten with vellum on the way up.
      expect(webSearch(readConfig())).toEqual({
        mode: "managed",
        provider: "vellum",
      });
    });

    test("restores your-own for a BYOK provider", () => {
      writeConfig({
        services: { "web-search": { provider: "firecrawl" } },
      });

      webSearchModeToProviderMigration.down!(workspaceDir);

      expect(webSearch(readConfig())).toEqual({
        mode: "your-own",
        provider: "firecrawl",
      });
    });

    // The managed pairing was erased on the way up, so Provider Native rolls
    // back to your-own even if it had been paired with managed mode.
    test("rolls inference-provider-native back to your-own", () => {
      writeConfig({
        services: {
          "web-search": { provider: "inference-provider-native" },
        },
      });

      webSearchModeToProviderMigration.down!(workspaceDir);

      expect(webSearch(readConfig())).toEqual({
        mode: "your-own",
        provider: "inference-provider-native",
      });
    });

    test("does not re-add mode when it is already present", () => {
      writeConfig({
        services: { "web-search": { mode: "your-own", provider: "brave" } },
      });

      webSearchModeToProviderMigration.down!(workspaceDir);

      expect(webSearch(readConfig())).toEqual({
        mode: "your-own",
        provider: "brave",
      });
    });
  });
});
