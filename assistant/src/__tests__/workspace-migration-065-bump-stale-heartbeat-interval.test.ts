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

import { bumpStaleHeartbeatIntervalMigration } from "../workspace/migrations/065-bump-stale-heartbeat-interval.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-065-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function configPath(): string {
  return join(workspaceDir, "config.json");
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify(data, null, 2) + "\n");
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), "utf-8"));
}

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("065-bump-stale-heartbeat-interval migration", () => {
  test("has correct migration id and is registered", () => {
    expect(bumpStaleHeartbeatIntervalMigration.id).toBe(
      "065-bump-stale-heartbeat-interval",
    );
    expect(WORKSPACE_MIGRATIONS.map((m) => m.id)).toContain(
      "065-bump-stale-heartbeat-interval",
    );
  });

  test("bumps stale baked 6-hour default to 30 minutes", () => {
    writeConfig({
      heartbeat: {
        enabled: true,
        intervalMs: 6 * 60 * 60 * 1000,
        activeHoursStart: 8,
        activeHoursEnd: 22,
      },
    });

    bumpStaleHeartbeatIntervalMigration.run(workspaceDir);

    expect(readConfig()).toEqual({
      heartbeat: {
        enabled: true,
        intervalMs: THIRTY_MINUTES_MS,
        activeHoursStart: 8,
        activeHoursEnd: 22,
      },
    });
  });

  test("bumps stale baked 3-hour default to 30 minutes", () => {
    writeConfig({
      heartbeat: {
        intervalMs: 3 * 60 * 60 * 1000,
      },
    });

    bumpStaleHeartbeatIntervalMigration.run(workspaceDir);

    expect((readConfig().heartbeat as Record<string, unknown>).intervalMs).toBe(
      THIRTY_MINUTES_MS,
    );
  });

  test("preserves custom heartbeat intervals", () => {
    writeConfig({
      heartbeat: {
        intervalMs: 60 * 60 * 1000,
      },
    });

    bumpStaleHeartbeatIntervalMigration.run(workspaceDir);

    expect(readConfig()).toEqual({
      heartbeat: {
        intervalMs: 60 * 60 * 1000,
      },
    });
  });

  test("is a no-op when config or heartbeat interval is absent", () => {
    bumpStaleHeartbeatIntervalMigration.run(workspaceDir);
    expect(existsSync(configPath())).toBe(false);

    writeConfig({ heartbeat: { enabled: true }, other: "value" });
    bumpStaleHeartbeatIntervalMigration.run(workspaceDir);
    expect(readConfig()).toEqual({
      heartbeat: { enabled: true },
      other: "value",
    });
  });
});
