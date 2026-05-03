/**
 * Regression test for the `setHeartbeatConfig` HTTP handler.
 *
 * The handler used to call `saveConfig({ ...config, heartbeat })`, which
 * serialised the full Zod-defaulted config to disk and baked
 * `intervalMs`/`activeHoursStart`/`activeHoursEnd` into `config.json`
 * even when the caller never set them. The migration to
 * `loadRawConfig` + `saveRawConfig` writes only the user-set fields
 * while still returning the resolved (post-default) values in the
 * response payload.
 *
 * `getConfig` is stubbed to read raw + apply Zod defaults in-memory.
 * The real `loadConfig` would otherwise trigger `backfillConfigDefaults`,
 * which writes the full schema-defaulted config back to disk on every
 * read and would clobber the on-disk assertions below. PR 2 of this
 * plan removes that daemon-load backfill; once it lands, this stub
 * could be replaced with the real `getConfig`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { RouteDefinition } from "../types.js";

// ─── Module mocks ──────────────────────────────────────────────────────────

// Stub the heartbeat service so the response-path's getInstance() returns
// undefined (no scheduler running in tests).
mock.module("../../../heartbeat/heartbeat-service.js", () => ({
  HeartbeatService: {
    getInstance: () => undefined,
  },
}));

// Wrap the loader: keep loadRawConfig/saveRawConfig/invalidateConfigCache
// real (they're the I/O paths under test) but replace getConfig so the
// daemon-load backfill side effect doesn't write schema defaults back to
// disk between our save and our assertions.
const realLoader = await import("../../../config/loader.js");
mock.module("../../../config/loader.js", () => ({
  ...realLoader,
  getConfig: () => realLoader.applyNestedDefaults(realLoader.loadRawConfig()),
}));

// Dynamic import after mocks are wired.
const { ROUTES } = await import("../heartbeat-routes.js");

// ─── Setup ─────────────────────────────────────────────────────────────────

let workspaceDir: string;
let origWorkspaceDir: string | undefined;
let configPath: string;

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route.handler;
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hbr-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  configPath = join(workspaceDir, "config.json");
  realLoader.invalidateConfigCache();
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  realLoader.invalidateConfigCache();
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("setHeartbeatConfig handler", () => {
  test("persists only user-set fields when starting from a config with no heartbeat block", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ provider: "anthropic" }, null, 2) + "\n",
    );

    const handler = findHandler("updateHeartbeatConfig");
    const result = (await handler({ body: { enabled: true } })) as {
      enabled: boolean;
      intervalMs: number;
      activeHoursStart: number | null;
      activeHoursEnd: number | null;
      success: boolean;
    };

    // On-disk: only user-set heartbeat fields, no schema defaults baked in.
    const onDisk = readConfig();
    expect(onDisk).toEqual({
      provider: "anthropic",
      heartbeat: { enabled: true },
    });

    // Response: schema-default intervalMs surfaces, proving cache
    // invalidation + getConfig() read picked up the new on-disk state.
    expect(result.success).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.intervalMs).toBe(6 * 3_600_000);
    expect(result.activeHoursStart).toBe(8);
    expect(result.activeHoursEnd).toBe(22);
  });

  test("merges patch into existing heartbeat block instead of overwriting", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ heartbeat: { intervalMs: 60000 } }, null, 2) + "\n",
    );

    const handler = findHandler("updateHeartbeatConfig");
    await handler({ body: { enabled: true } });

    const onDisk = readConfig();
    expect(onDisk).toEqual({
      heartbeat: { intervalMs: 60000, enabled: true },
    });
  });
});
