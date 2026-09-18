/**
 * Schedule-worker MCP bootstrap and reload.
 *
 * The worker hosts execute/wake/workflow turns in its own process, so it
 * has to connect MCP servers itself. Tool-backed schedules must not fire
 * until that pass has settled: a 20s grace lets notify/script start, and
 * the readiness latch defers the rest until registration finishes or
 * fails closed.
 */

import {
  restartConfiguredMcpServers,
  startConfiguredMcpServers,
} from "../mcp/startup.js";
import {
  EMPTY_MCP_STARTUP_SNAPSHOT,
  type McpStartupSnapshot,
} from "../mcp/tool-caps.js";
import { getLogger } from "../util/logger.js";
import {
  markScheduleToolSurfaceReady,
  markScheduleToolSurfaceReloading,
  markScheduleToolSurfaceStarting,
} from "./tool-surface-readiness.js";

export { MCP_NOT_READY_DEFER_MS } from "./tool-surface-readiness.js";

const log = getLogger("schedule-worker-mcp");

/**
 * How long startup waits before arming notify/script ticks.
 *
 * Connecting is worth waiting for. It is not worth waiting for without
 * limit: each server may take 30s to connect and 30s to list tools. Past
 * this deadline those ticks start. Tool-backed schedules stay deferred
 * until {@link markScheduleToolSurfaceReady}.
 */
export const MCP_STARTUP_GRACE_MS = 20_000;

export async function bootstrapScheduleWorkerMcp(options?: {
  start?: () => Promise<McpStartupSnapshot>;
  graceMs?: number;
}): Promise<void> {
  const start = options?.start ?? startConfiguredMcpServers;
  const graceMs = options?.graceMs ?? MCP_STARTUP_GRACE_MS;
  markScheduleToolSurfaceStarting();
  const startup = start()
    .then((snapshot) => {
      markScheduleToolSurfaceReady(snapshot);
      log.info(snapshot, "MCP tool surface ready in schedule worker");
      return snapshot;
    })
    .catch((err: unknown) => {
      markScheduleToolSurfaceReady(EMPTY_MCP_STARTUP_SNAPSHOT);
      log.error(
        { err },
        "MCP tool surface failed in schedule worker; continuing without MCP tools",
      );
      return EMPTY_MCP_STARTUP_SNAPSHOT;
    });

  await Promise.race([
    startup,
    new Promise<void>((resolve) => {
      setTimeout(resolve, graceMs).unref();
    }),
  ]);
}

export async function reloadScheduleWorkerMcp(options?: {
  restart?: () => Promise<McpStartupSnapshot>;
}): Promise<McpStartupSnapshot> {
  const restart = options?.restart ?? restartConfiguredMcpServers;
  markScheduleToolSurfaceReloading();
  try {
    const snapshot = await restart();
    markScheduleToolSurfaceReady(snapshot);
    log.info(snapshot, "MCP servers reloaded in schedule worker");
    return snapshot;
  } catch (err) {
    markScheduleToolSurfaceReady(EMPTY_MCP_STARTUP_SNAPSHOT);
    log.warn({ err }, "MCP reload failed in schedule worker");
    throw err;
  }
}
