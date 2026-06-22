/**
 * Tests for workspace migration `102-preserve-heartbeat-enabled-for-existing-workspaces`.
 *
 * The schema default for `heartbeat.enabled` flipped from true to false so
 * heartbeats are opt-in for new users. The migration persists an explicit
 * `enabled: true` for upgrading workspaces that never wrote the key (they
 * relied on the old default-on behavior), creating `config.json` when it
 * does not exist. It must skip fresh workspaces, leave explicit user values
 * untouched, and be idempotent.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HeartbeatConfigSchema } from "../config/schemas/heartbeat.js";
import { preserveHeartbeatEnabledForExistingWorkspacesMigration } from "../workspace/migrations/102-preserve-heartbeat-enabled-for-existing-workspaces.js";
import type { MigrationRunContext } from "../workspace/migrations/types.js";

const NEW_WORKSPACE_CTX: MigrationRunContext = { isNewWorkspace: true };
const UPGRADE_CTX: MigrationRunContext = { isNewWorkspace: false };

let workspaceDir: string;
let configPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-102-test-"));
  configPath = join(workspaceDir, "config.json");
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

describe("102-preserve-heartbeat-enabled-for-existing-workspaces migration", () => {
  test("has correct id and description", () => {
    expect(preserveHeartbeatEnabledForExistingWorkspacesMigration.id).toBe(
      "102-preserve-heartbeat-enabled-for-existing-workspaces",
    );
    expect(
      preserveHeartbeatEnabledForExistingWorkspacesMigration.description,
    ).toContain("heartbeat.enabled");
  });

  test("schema default is disabled (the flip this migration compensates for)", () => {
    expect(HeartbeatConfigSchema.parse({}).enabled).toBe(false);
  });

  test("skips fresh workspaces so new users get the opt-in default", () => {
    preserveHeartbeatEnabledForExistingWorkspacesMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );

    expect(existsSync(configPath)).toBe(false);
  });

  test("creates config.json with enabled=true when an existing workspace has none", () => {
    preserveHeartbeatEnabledForExistingWorkspacesMigration.run(
      workspaceDir,
      UPGRADE_CTX,
    );

    expect(readConfig()).toEqual({ heartbeat: { enabled: true } });
  });

  test("adds heartbeat block to an existing config without one", () => {
    writeFileSync(configPath, JSON.stringify({ name: "Assistant" }), "utf-8");

    preserveHeartbeatEnabledForExistingWorkspacesMigration.run(
      workspaceDir,
      UPGRADE_CTX,
    );

    expect(readConfig()).toEqual({
      name: "Assistant",
      heartbeat: { enabled: true },
    });
  });

  test("adds enabled=true to a heartbeat block without the key, preserving siblings", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ heartbeat: { intervalMs: 1800000 } }),
      "utf-8",
    );

    preserveHeartbeatEnabledForExistingWorkspacesMigration.run(
      workspaceDir,
      UPGRADE_CTX,
    );

    expect(readConfig()).toEqual({
      heartbeat: { intervalMs: 1800000, enabled: true },
    });
  });

  test.each([[true], [false]])(
    "leaves an explicit enabled=%p untouched",
    (enabled) => {
      const original = JSON.stringify({ heartbeat: { enabled } });
      writeFileSync(configPath, original, "utf-8");

      preserveHeartbeatEnabledForExistingWorkspacesMigration.run(
        workspaceDir,
        UPGRADE_CTX,
      );

      expect(readFileSync(configPath, "utf-8")).toBe(original);
    },
  );

  test("treats a missing context as an existing workspace", () => {
    preserveHeartbeatEnabledForExistingWorkspacesMigration.run(workspaceDir);

    expect(readConfig()).toEqual({ heartbeat: { enabled: true } });
  });

  test("leaves malformed config.json untouched", () => {
    writeFileSync(configPath, "{ not json", "utf-8");

    preserveHeartbeatEnabledForExistingWorkspacesMigration.run(
      workspaceDir,
      UPGRADE_CTX,
    );

    expect(readFileSync(configPath, "utf-8")).toBe("{ not json");
  });

  test("leaves a non-object heartbeat value untouched", () => {
    const original = JSON.stringify({ heartbeat: "off" });
    writeFileSync(configPath, original, "utf-8");

    preserveHeartbeatEnabledForExistingWorkspacesMigration.run(
      workspaceDir,
      UPGRADE_CTX,
    );

    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  test("is idempotent", () => {
    preserveHeartbeatEnabledForExistingWorkspacesMigration.run(
      workspaceDir,
      UPGRADE_CTX,
    );
    const afterFirst = readFileSync(configPath, "utf-8");

    preserveHeartbeatEnabledForExistingWorkspacesMigration.run(
      workspaceDir,
      UPGRADE_CTX,
    );

    expect(readFileSync(configPath, "utf-8")).toBe(afterFirst);
  });

  test("down is a no-op", () => {
    preserveHeartbeatEnabledForExistingWorkspacesMigration.run(
      workspaceDir,
      UPGRADE_CTX,
    );
    const before = readFileSync(configPath, "utf-8");

    preserveHeartbeatEnabledForExistingWorkspacesMigration.down(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });
});
