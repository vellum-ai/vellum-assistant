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

import { clearRenamedCostProfileLabelMigration } from "../workspace/migrations/139-clear-renamed-cost-profile-label.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-139-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function costProfile(): Record<string, unknown> {
  const config = JSON.parse(
    readFileSync(join(workspaceDir, "config.json"), "utf-8"),
  );
  return config.llm.profiles["cost-optimized"];
}

function run(): void {
  clearRenamedCostProfileLabelMigration.run(workspaceDir);
}

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("139-clear-renamed-cost-profile-label migration", () => {
  test("has correct migration id and is registered", () => {
    expect(clearRenamedCostProfileLabelMigration.id).toBe(
      "139-clear-renamed-cost-profile-label",
    );
    expect(
      WORKSPACE_MIGRATIONS.some(
        (migration) => migration.id === "139-clear-renamed-cost-profile-label",
      ),
    ).toBe(true);
  });

  test("clears the seeded label so the code catalog label applies", () => {
    writeConfig({
      llm: {
        profiles: {
          "cost-optimized": { source: "managed", label: "Speed" },
        },
      },
    });

    run();

    expect(costProfile()).toEqual({ source: "managed" });
  });

  test("leaves a user rename, an explicit null, and hatch stubs alone", () => {
    for (const label of ["My Fast One", null, "Speed (Managed)"]) {
      freshWorkspace();
      writeConfig({
        llm: { profiles: { "cost-optimized": { source: "managed", label } } },
      });

      run();

      expect(costProfile().label).toBe(label as string);
    }
  });

  test("leaves a source-less legacy entry alone", () => {
    // A source-less entry under a default name shadows the catalog outright,
    // so its label is user state.
    writeConfig({
      llm: { profiles: { "cost-optimized": { label: "Speed" } } },
    });

    run();

    expect(costProfile().label).toBe("Speed");
  });

  test("leaves a user-owned profile shadowing the default name alone", () => {
    writeConfig({
      llm: {
        profiles: {
          "cost-optimized": {
            source: "user",
            label: "Speed",
            provider: "anthropic",
            model: "claude-haiku-4-5-20251001",
          },
        },
      },
    });

    run();

    expect(costProfile().label).toBe("Speed");
  });

  test("is idempotent and no-ops on absent or malformed config", () => {
    writeConfig({
      llm: { profiles: { "cost-optimized": { source: "managed" } } },
    });
    run();
    run();
    expect(costProfile()).toEqual({ source: "managed" });

    freshWorkspace();
    expect(() => run()).not.toThrow();

    writeFileSync(join(workspaceDir, "config.json"), "{not json");
    expect(() => run()).not.toThrow();
  });
});
