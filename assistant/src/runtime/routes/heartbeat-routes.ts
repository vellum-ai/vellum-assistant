/**
 * Route handlers for heartbeat management.
 *
 * All routes served by both the HTTP server and the IPC server via the
 * shared ROUTES array.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import { getConfig, saveConfig } from "../../config/loader.js";
import { listHeartbeatRuns } from "../../heartbeat/heartbeat-run-store.js";
import { HeartbeatService } from "../../heartbeat/heartbeat-service.js";
import { readTextFileSync } from "../../util/fs.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspacePromptPath } from "../../util/platform.js";
import { BadRequestError, InternalError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("heartbeat-routes");

// ---------------------------------------------------------------------------
// Handlers (transport-agnostic)
// ---------------------------------------------------------------------------

function handleListRuns(queryParams: Record<string, string>) {
  const rawLimit = Number(queryParams.limit ?? 20);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), 100)
    : 20;

  const runs = listHeartbeatRuns(limit);
  return {
    runs: runs.map((r) => ({
      id: r.id,
      scheduledFor: r.scheduledFor,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      status: r.status,
      skipReason: r.skipReason,
      error: r.error,
      conversationId: r.conversationId,
      createdAt: r.createdAt,
    })),
  };
}

function handleGetChecklist() {
  const path = getWorkspacePromptPath("HEARTBEAT.md");
  const content = readTextFileSync(path);
  return {
    content: content ?? "",
    isDefault: content == null,
  };
}

function handleWriteChecklist(body: Record<string, unknown>) {
  const content = body.content;
  if (typeof content !== "string") {
    throw new BadRequestError("content is required");
  }
  const path = getWorkspacePromptPath("HEARTBEAT.md");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    log.info("Heartbeat checklist updated");
    return { success: true };
  } catch (err) {
    log.error({ err }, "Failed to write heartbeat checklist");
    throw new InternalError("Failed to write checklist");
  }
}

// ---------------------------------------------------------------------------
// Shared route definitions (HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "listHeartbeatRuns",
    endpoint: "heartbeat/runs",
    method: "GET",
    policyKey: "heartbeat",
    summary: "List heartbeat runs",
    description: "Return recent heartbeat conversation runs.",
    tags: ["heartbeat"],
    queryParams: [
      {
        name: "limit",
        schema: { type: "integer" },
        description: "Max runs to return (default 20, max 100)",
      },
    ],
    responseBody: z.object({
      runs: z
        .array(
          z.object({
            id: z.string(),
            scheduledFor: z.number(),
            startedAt: z.number().nullable(),
            finishedAt: z.number().nullable(),
            durationMs: z.number().nullable(),
            status: z.string(),
            skipReason: z.string().nullable(),
            error: z.string().nullable(),
            conversationId: z.string().nullable(),
            createdAt: z.number(),
          }),
        )
        .describe("Heartbeat run records"),
    }),
    handler: ({ queryParams }: RouteHandlerArgs) =>
      handleListRuns(queryParams ?? {}),
  },
  {
    operationId: "getHeartbeatChecklist",
    endpoint: "heartbeat/checklist",
    method: "GET",
    policyKey: "heartbeat",
    summary: "Get heartbeat checklist",
    description: "Return the HEARTBEAT.md checklist content.",
    tags: ["heartbeat"],
    responseBody: z.object({
      content: z.string().describe("Checklist markdown content"),
      isDefault: z.boolean().describe("True when no custom checklist exists"),
    }),
    handler: () => handleGetChecklist(),
  },
  {
    operationId: "writeHeartbeatChecklist",
    endpoint: "heartbeat/checklist",
    method: "PUT",
    policyKey: "heartbeat",
    summary: "Write heartbeat checklist",
    description: "Overwrite the HEARTBEAT.md checklist content.",
    tags: ["heartbeat"],
    requestBody: z.object({
      content: z.string().describe("Checklist markdown content"),
    }),
    responseBody: z.object({
      success: z.boolean(),
    }),
    handler: ({ body }: RouteHandlerArgs) => handleWriteChecklist(body ?? {}),
  },
  {
    operationId: "getHeartbeatConfig",
    endpoint: "heartbeat/config",
    method: "GET",
    policyKey: "heartbeat",
    requirePolicyEnforcement: true,
    summary: "Get heartbeat config",
    description: "Return the current heartbeat schedule configuration.",
    tags: ["heartbeat"],
    responseBody: z.object({
      enabled: z.boolean(),
      intervalMs: z.number(),
      activeHoursStart: z.number().nullable(),
      activeHoursEnd: z.number().nullable(),
      nextRunAt: z.number().nullable(),
      lastRunAt: z.number().nullable(),
      success: z.boolean(),
    }),
    handler: async (_args: RouteHandlerArgs) => {
      const config = getConfig().heartbeat;
      const svc = HeartbeatService.getInstance();
      return {
        enabled: config.enabled,
        intervalMs: config.intervalMs,
        activeHoursStart: config.activeHoursStart ?? null,
        activeHoursEnd: config.activeHoursEnd ?? null,
        nextRunAt: svc?.nextRunAt ?? null,
        lastRunAt: svc?.lastRunAt ?? null,
        success: true,
      };
    },
  },
  {
    operationId: "updateHeartbeatConfig",
    endpoint: "heartbeat/config",
    method: "PUT",
    policyKey: "heartbeat",
    requirePolicyEnforcement: true,
    summary: "Update heartbeat config",
    description: "Update the heartbeat schedule configuration.",
    tags: ["heartbeat"],
    requestBody: z.object({
      enabled: z.boolean().describe("Enable or disable heartbeat"),
      intervalMs: z.number().describe("Heartbeat interval in ms"),
      activeHoursStart: z.number().describe("Active hours start (0–23)"),
      activeHoursEnd: z.number().describe("Active hours end (0–23)"),
    }),
    responseBody: z.object({
      enabled: z.boolean(),
      intervalMs: z.number(),
      activeHoursStart: z.number().nullable(),
      activeHoursEnd: z.number().nullable(),
      nextRunAt: z.number().nullable(),
      lastRunAt: z.number().nullable(),
      success: z.boolean(),
    }),
    handler: async ({ body = {} }: RouteHandlerArgs) => {
      const config = getConfig();
      const heartbeat = { ...config.heartbeat };

      if (typeof body.enabled === "boolean") heartbeat.enabled = body.enabled;
      if (typeof body.intervalMs === "number")
        heartbeat.intervalMs = body.intervalMs;
      if (typeof body.activeHoursStart === "number")
        heartbeat.activeHoursStart = body.activeHoursStart;
      if (typeof body.activeHoursEnd === "number")
        heartbeat.activeHoursEnd = body.activeHoursEnd;

      try {
        saveConfig({ ...config, heartbeat });
        log.info({ heartbeat }, "Heartbeat config updated");
      } catch (err) {
        log.error({ err }, "Failed to save heartbeat config");
        throw new InternalError("Failed to save config");
      }

      const svc = HeartbeatService.getInstance();
      return {
        enabled: heartbeat.enabled,
        intervalMs: heartbeat.intervalMs,
        activeHoursStart: heartbeat.activeHoursStart ?? null,
        activeHoursEnd: heartbeat.activeHoursEnd ?? null,
        nextRunAt: svc?.nextRunAt ?? null,
        lastRunAt: svc?.lastRunAt ?? null,
        success: true,
      };
    },
  },
  {
    operationId: "runHeartbeatNow",
    endpoint: "heartbeat/run-now",
    method: "POST",
    policyKey: "heartbeat",
    requirePolicyEnforcement: true,
    summary: "Run heartbeat now",
    description: "Trigger an immediate heartbeat run.",
    tags: ["heartbeat"],
    responseBody: z.object({
      success: z.boolean(),
      ran: z.boolean().describe("Whether the heartbeat actually ran"),
    }),
    handler: async (_args: RouteHandlerArgs) => {
      const svc = HeartbeatService.getInstance();
      if (!svc) {
        throw new InternalError("Heartbeat service not available");
      }
      try {
        const ran = await svc.runOnce({ force: true });
        return { success: true, ran };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err }, "Heartbeat run-now failed");
        return { success: false, ran: false, error: message };
      }
    },
  },
];
