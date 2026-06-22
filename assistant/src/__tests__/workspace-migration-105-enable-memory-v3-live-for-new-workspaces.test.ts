/**
 * Tests for workspace migration `105-enable-memory-v3-live-for-new-workspaces`.
 *
 * The schema default for `memory.v3.live` is false so existing assistants stay
 * on v2. The migration persists `memory.v3.live = true` for FRESH workspaces
 * only (switching new assistants onto memory-v3 at creation), creating
 * `config.json` when it does not exist, leaving existing workspaces and
 * explicit values untouched, and being idempotent.
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

import { MemoryV3ConfigSchema } from "../config/schemas/memory-v3.js";
import { enableMemoryV3LiveForNewWorkspacesMigration } from "../workspace/migrations/105-enable-memory-v3-live-for-new-workspaces.js";
import type { MigrationRunContext } from "../workspace/migrations/types.js";

const NEW_WORKSPACE_CTX: MigrationRunContext = { isNewWorkspace: true };
const UPGRADE_CTX: MigrationRunContext = { isNewWorkspace: false };

let workspaceDir: string;
let configPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-105-test-"));
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

describe("105-enable-memory-v3-live-for-new-workspaces migration", () => {
  test("has correct id and description", () => {
    expect(enableMemoryV3LiveForNewWorkspacesMigration.id).toBe(
      "105-enable-memory-v3-live-for-new-workspaces",
    );
    expect(enableMemoryV3LiveForNewWorkspacesMigration.description).toContain(
      "memory.v3.live",
    );
  });

  test("schema default is off so existing assistants stay on v2", () => {
    expect(MemoryV3ConfigSchema.parse({}).live).toBe(false);
  });

  test("creates config.json with memory.v3.live=true for a fresh workspace", () => {
    enableMemoryV3LiveForNewWorkspacesMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );

    expect(readConfig()).toEqual({ memory: { v3: { live: true } } });
  });

  test("adds memory.v3.live to a fresh workspace's existing config, preserving siblings", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ name: "Assistant", memory: { enabled: true } }),
      "utf-8",
    );

    enableMemoryV3LiveForNewWorkspacesMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );

    expect(readConfig()).toEqual({
      name: "Assistant",
      memory: { enabled: true, v3: { live: true } },
    });
  });

  test("skips existing workspaces so they stay on v2 (no config written)", () => {
    enableMemoryV3LiveForNewWorkspacesMigration.run(workspaceDir, UPGRADE_CTX);

    expect(existsSync(configPath)).toBe(false);
  });

  test("treats a missing context as an existing workspace", () => {
    enableMemoryV3LiveForNewWorkspacesMigration.run(workspaceDir);

    expect(existsSync(configPath)).toBe(false);
  });

  test("leaves an explicit memory.v3.live value untouched on a fresh workspace", () => {
    const original = JSON.stringify({ memory: { v3: { live: false } } });
    writeFileSync(configPath, original, "utf-8");

    enableMemoryV3LiveForNewWorkspacesMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );

    expect(readFileSync(configPath, "utf-8")).toBe(original);
  });

  test("leaves malformed config.json untouched", () => {
    writeFileSync(configPath, "{ not json", "utf-8");

    enableMemoryV3LiveForNewWorkspacesMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );

    expect(readFileSync(configPath, "utf-8")).toBe("{ not json");
  });

  test("is idempotent", () => {
    enableMemoryV3LiveForNewWorkspacesMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );
    const afterFirst = readFileSync(configPath, "utf-8");

    enableMemoryV3LiveForNewWorkspacesMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );

    expect(readFileSync(configPath, "utf-8")).toBe(afterFirst);
  });

  test("down is a no-op", () => {
    enableMemoryV3LiveForNewWorkspacesMigration.run(
      workspaceDir,
      NEW_WORKSPACE_CTX,
    );
    const before = readFileSync(configPath, "utf-8");

    enableMemoryV3LiveForNewWorkspacesMigration.down(workspaceDir);

    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });
});
