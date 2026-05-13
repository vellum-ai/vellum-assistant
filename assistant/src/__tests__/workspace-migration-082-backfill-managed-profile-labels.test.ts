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

import { backfillManagedProfileLabelsMigration } from "../workspace/migrations/082-backfill-managed-profile-labels.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-082-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("082-backfill-managed-profile-labels migration", () => {
  test("has correct migration id", () => {
    expect(backfillManagedProfileLabelsMigration.id).toBe(
      "082-backfill-managed-profile-labels",
    );
  });

  test("backfills missing labels on the canonical managed triplet (Marina QA #5)", () => {
    // The exact shape migration 052 writes — provider + model + numeric
    // tuning fields, no label, no source, no provider_connection.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            maxTokens: 16000,
            effort: "high",
            thinking: { enabled: true, streamThinking: true },
          },
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-7",
            maxTokens: 32000,
            effort: "max",
            thinking: { enabled: true, streamThinking: true },
          },
          "cost-optimized": {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            maxTokens: 8192,
            effort: "low",
            thinking: { enabled: false, streamThinking: false },
          },
        },
        activeProfile: "balanced",
      },
    });

    backfillManagedProfileLabelsMigration.run(workspaceDir);

    const config = readConfig();
    const profiles = (config.llm as Record<string, unknown>).profiles as Record<
      string,
      Record<string, unknown>
    >;
    expect(profiles.balanced.label).toBe("Balanced");
    expect(profiles["quality-optimized"].label).toBe("Quality");
    expect(profiles["cost-optimized"].label).toBe("Speed");
  });

  test("preserves user-set string labels without rewriting", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            label: "My Balanced",
          },
          "quality-optimized": {
            provider: "anthropic",
            model: "claude-opus-4-7",
            // No label — backfills.
          },
          "cost-optimized": {
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
            label: "Speed (Managed)",
          },
        },
      },
    });

    backfillManagedProfileLabelsMigration.run(workspaceDir);

    const config = readConfig();
    const profiles = (config.llm as Record<string, unknown>).profiles as Record<
      string,
      Record<string, unknown>
    >;
    expect(profiles.balanced.label).toBe("My Balanced");
    expect(profiles["quality-optimized"].label).toBe("Quality");
    expect(profiles["cost-optimized"].label).toBe("Speed (Managed)");
  });

  test("preserves explicit null labels (user cleared the label)", () => {
    // `null` is a meaningful signal — the user cleared the label via the
    // PUT route. Treat the key as present and skip backfill.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            label: null,
          },
        },
      },
    });

    backfillManagedProfileLabelsMigration.run(workspaceDir);

    const config = readConfig();
    const profiles = (config.llm as Record<string, unknown>).profiles as Record<
      string,
      Record<string, unknown>
    >;
    expect(profiles.balanced.label).toBeNull();
  });

  test("does NOT touch non-canonical profile names", () => {
    writeConfig({
      llm: {
        profiles: {
          "my-custom": {
            provider: "openai",
            model: "gpt-5.4",
            // No label — must NOT be backfilled.
          },
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            // Missing label — gets backfilled.
          },
        },
      },
    });

    backfillManagedProfileLabelsMigration.run(workspaceDir);

    const config = readConfig();
    const profiles = (config.llm as Record<string, unknown>).profiles as Record<
      string,
      Record<string, unknown>
    >;
    expect("label" in profiles["my-custom"]).toBe(false);
    expect(profiles.balanced.label).toBe("Balanced");
  });

  test("is idempotent — second run produces no further changes", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      },
    });

    backfillManagedProfileLabelsMigration.run(workspaceDir);
    const afterFirst = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );

    backfillManagedProfileLabelsMigration.run(workspaceDir);
    const afterSecond = readFileSync(
      join(workspaceDir, "config.json"),
      "utf-8",
    );

    expect(afterSecond).toBe(afterFirst);
  });

  test("no-op when config.json does not exist", () => {
    // Fresh workspace, no config file. Migration must not throw or create
    // the file.
    backfillManagedProfileLabelsMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when llm.profiles is absent", () => {
    writeConfig({ llm: { default: { provider: "anthropic" } } });
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");

    backfillManagedProfileLabelsMigration.run(workspaceDir);

    const after = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    expect(after).toBe(before);
  });

  test("ignores malformed config.json without throwing", () => {
    writeFileSync(join(workspaceDir, "config.json"), "{ not valid json");
    // Should not throw.
    expect(() =>
      backfillManagedProfileLabelsMigration.run(workspaceDir),
    ).not.toThrow();
  });

  test("does NOT skip when VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH is set", () => {
    // Unlike the seed migrations (040/046/052/054/...), this is a forward
    // data repair that runs regardless. Platform-supplied overlay labels
    // already win at the profile level (the on-disk entry has a `label`
    // key, so this migration leaves it alone). Skipping the whole
    // migration when the env var is set would leave migration-052 holes
    // unhealed on platform-style hatches.
    process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH = "/tmp/overlay.json";
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
      },
    });

    try {
      backfillManagedProfileLabelsMigration.run(workspaceDir);

      const config = readConfig();
      const profiles = (config.llm as Record<string, unknown>)
        .profiles as Record<string, Record<string, unknown>>;
      expect(profiles.balanced.label).toBe("Balanced");
    } finally {
      delete process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
    }
  });
});
