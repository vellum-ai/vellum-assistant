/**
 * Asserts `setHeartbeatConfig` persists only user-set heartbeat fields to
 * `config.json` and surfaces the resolved (post-default) values via the
 * response payload.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { invalidateConfigCache } from "../../../config/loader.js";
import { ROUTES } from "../heartbeat-routes.js";
import type { RouteDefinition } from "../types.js";

// ─── Module mocks ──────────────────────────────────────────────────────────

// Stub the heartbeat service so the response-path's getInstance() returns a
// reconfigure spy and surfaces no scheduler-derived values.
const reconfigureSpy = mock(() => {});
mock.module("../../../heartbeat/heartbeat-service.js", () => ({
  HeartbeatService: {
    getInstance: () => ({
      reconfigure: reconfigureSpy,
      nextRunAt: null,
      lastRunAt: null,
    }),
  },
}));

// ─── Setup ─────────────────────────────────────────────────────────────────

let workspaceDir: string;
let origWorkspaceDir: string | undefined;
let configPath: string;

function findRoute(operationId: string): RouteDefinition {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) throw new Error(`Route ${operationId} not found`);
  return route;
}

function findHandler(operationId: string): RouteDefinition["handler"] {
  return findRoute(operationId).handler;
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hbr-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  configPath = join(workspaceDir, "config.json");
  invalidateConfigCache();
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  invalidateConfigCache();
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
    expect(result.intervalMs).toBe(60 * 60_000);
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

describe("heartbeat run caps", () => {
  test("PUT persists maxDailyRuns and GET reflects it", async () => {
    writeFileSync(configPath, JSON.stringify({}, null, 2) + "\n");

    const put = findHandler("updateHeartbeatConfig");
    const putResult = (await put({ body: { maxDailyRuns: 6 } })) as {
      maxDailyRuns: number | null;
    };
    expect(putResult.maxDailyRuns).toBe(6);

    expect(readConfig()).toEqual({ heartbeat: { maxDailyRuns: 6 } });

    const get = findHandler("getHeartbeatConfig");
    const getResult = (await get({})) as { maxDailyRuns: number | null };
    expect(getResult.maxDailyRuns).toBe(6);
  });

  test("PUT with null clears maxConsecutiveRuns (unbounded)", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ heartbeat: { maxConsecutiveRuns: 5 } }, null, 2) + "\n",
    );

    const put = findHandler("updateHeartbeatConfig");
    const putResult = (await put({
      body: { maxConsecutiveRuns: null },
    })) as { maxConsecutiveRuns: number | null };
    expect(putResult.maxConsecutiveRuns).toBeNull();

    expect(readConfig()).toEqual({ heartbeat: { maxConsecutiveRuns: null } });
  });

  test("PUT handler rejects invalid cap values instead of coercing to null", async () => {
    writeFileSync(configPath, JSON.stringify({}, null, 2) + "\n");
    const put = findHandler("updateHeartbeatConfig");

    // A string must be rejected, not silently coerced to null (which the
    // heartbeat service treats as "unlimited", disabling the cost cap).
    await expect(put({ body: { maxDailyRuns: "6" } })).rejects.toThrow(
      /maxDailyRuns/,
    );
    await expect(put({ body: { maxConsecutiveRuns: "5" } })).rejects.toThrow(
      /maxConsecutiveRuns/,
    );
    await expect(put({ body: { maxDailyRuns: 0 } })).rejects.toThrow();
    await expect(put({ body: { maxConsecutiveRuns: -1 } })).rejects.toThrow();
    await expect(put({ body: { maxDailyRuns: 1.5 } })).rejects.toThrow();

    // No invalid write should have reached disk.
    expect(readConfig()).toEqual({});
  });

  test("PUT handler accepts a positive integer and null cap values", async () => {
    writeFileSync(configPath, JSON.stringify({}, null, 2) + "\n");
    const put = findHandler("updateHeartbeatConfig");

    const okResult = (await put({ body: { maxDailyRuns: 6 } })) as {
      maxDailyRuns: number | null;
    };
    expect(okResult.maxDailyRuns).toBe(6);
    expect(readConfig()).toEqual({ heartbeat: { maxDailyRuns: 6 } });

    const nullResult = (await put({ body: { maxDailyRuns: null } })) as {
      maxDailyRuns: number | null;
    };
    expect(nullResult.maxDailyRuns).toBeNull();
    expect(readConfig()).toEqual({ heartbeat: { maxDailyRuns: null } });
  });

  test("reconfigure() is invoked after a successful write", async () => {
    writeFileSync(configPath, JSON.stringify({}, null, 2) + "\n");
    reconfigureSpy.mockClear();

    const put = findHandler("updateHeartbeatConfig");
    await put({ body: { maxDailyRuns: 4 } });

    expect(reconfigureSpy).toHaveBeenCalledTimes(1);
  });
});
