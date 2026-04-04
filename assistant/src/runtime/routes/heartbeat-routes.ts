/**
 * HTTP route handlers for heartbeat management.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getConfig, saveConfig } from "../../config/loader.js";
import type { HeartbeatService } from "../../heartbeat/heartbeat-service.js";
import { getDb } from "../../memory/db.js";
import { conversations } from "../../memory/schema/conversations.js";
import { readTextFileSync } from "../../util/fs.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspacePromptPath } from "../../util/platform.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("heartbeat-routes");

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleGetConfig(heartbeatService?: HeartbeatService): Response {
  const config = getConfig().heartbeat;
  return Response.json({
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    activeHoursStart: config.activeHoursStart ?? null,
    activeHoursEnd: config.activeHoursEnd ?? null,
    nextRunAt: heartbeatService?.nextRunAt ?? null,
    lastRunAt: heartbeatService?.lastRunAt ?? null,
    success: true,
  });
}

function handleUpdateConfig(
  body: Record<string, unknown>,
  heartbeatService?: HeartbeatService,
): Response {
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
    log.info({ heartbeat }, "Heartbeat config updated via HTTP");
  } catch (err) {
    log.error({ err }, "Failed to save heartbeat config");
    return httpError("INTERNAL_ERROR", "Failed to save config", 500);
  }

  return Response.json({
    enabled: heartbeat.enabled,
    intervalMs: heartbeat.intervalMs,
    activeHoursStart: heartbeat.activeHoursStart ?? null,
    activeHoursEnd: heartbeat.activeHoursEnd ?? null,
    nextRunAt: heartbeatService?.nextRunAt ?? null,
    lastRunAt: heartbeatService?.lastRunAt ?? null,
    success: true,
  });
}

function handleListRuns(limit: number): Response {
  const db = getDb();
  const rows = db
    .select({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(eq(conversations.source, "heartbeat"))
    .orderBy(desc(conversations.createdAt))
    .limit(limit)
    .all();

  return Response.json({
    runs: rows.map((r) => ({
      id: r.id,
      title: r.title ?? "Heartbeat",
      createdAt: r.createdAt,
      result: "ok",
    })),
  });
}

async function handleRunNow(
  heartbeatService?: HeartbeatService,
): Promise<Response> {
  if (!heartbeatService) {
    return httpError(
      "SERVICE_UNAVAILABLE",
      "Heartbeat service not available",
      503,
    );
  }

  try {
    const ran = await heartbeatService.runOnce({ force: true });
    return Response.json({ success: true, ran });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Heartbeat run-now failed");
    return Response.json({ success: false, error: message });
  }
}

function handleGetChecklist(): Response {
  const path = getWorkspacePromptPath("HEARTBEAT.md");
  const content = readTextFileSync(path);
  return Response.json({
    content: content ?? "",
    isDefault: content == null,
  });
}

function handleWriteChecklist(content: string): Response {
  const path = getWorkspacePromptPath("HEARTBEAT.md");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    log.info("Heartbeat checklist updated via HTTP");
    return Response.json({ success: true });
  } catch (err) {
    log.error({ err }, "Failed to write heartbeat checklist");
    return httpError("INTERNAL_ERROR", "Failed to write checklist", 500);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function heartbeatRouteDefinitions(deps: {
  getHeartbeatService?: () => HeartbeatService | undefined;
}): RouteDefinition[] {
  return [
    {
      endpoint: "heartbeat/config",
      method: "GET",
      policyKey: "heartbeat",
      summary: "Get heartbeat config",
      description: "Return the current heartbeat schedule configuration.",
      tags: ["heartbeat"],
      responseBody: z.object({
        enabled: z.boolean(),
        intervalMs: z.number(),
        activeHoursStart: z.number(),
        activeHoursEnd: z.number(),
        nextRunAt: z.string(),
        success: z.boolean(),
      }),
      handler: () => handleGetConfig(deps.getHeartbeatService?.()),
    },
    {
      endpoint: "heartbeat/config",
      method: "PUT",
      policyKey: "heartbeat",
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
        activeHoursStart: z.number(),
        activeHoursEnd: z.number(),
        nextRunAt: z.string(),
        success: z.boolean(),
      }),
      handler: async ({ req }) => {
        const body: unknown = await req.json();
        if (typeof body !== "object" || !body || Array.isArray(body)) {
          return httpError(
            "BAD_REQUEST",
            "Request body must be a JSON object",
            400,
          );
        }
        return handleUpdateConfig(
          body as Record<string, unknown>,
          deps.getHeartbeatService?.(),
        );
      },
    },
    {
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
          description: "Max runs to return (default 20)",
        },
      ],
      responseBody: z.object({
        runs: z.array(z.unknown()).describe("Heartbeat run records"),
      }),
      handler: ({ url }) => {
        const limit = Number(url.searchParams.get("limit") ?? 20);
        return handleListRuns(limit);
      },
    },
    {
      endpoint: "heartbeat/run-now",
      method: "POST",
      policyKey: "heartbeat",
      summary: "Run heartbeat now",
      description: "Trigger an immediate heartbeat run.",
      tags: ["heartbeat"],
      responseBody: z.object({
        success: z.boolean(),
        ran: z.boolean().describe("Whether the heartbeat actually ran"),
      }),
      handler: () => handleRunNow(deps.getHeartbeatService?.()),
    },
    {
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
      handler: async ({ req }) => {
        const body = (await req.json()) as { content?: string };
        if (typeof body.content !== "string") {
          return httpError("BAD_REQUEST", "content is required", 400);
        }
        return handleWriteChecklist(body.content);
      },
    },
  ];
}
