/**
 * Debug introspection endpoint for monitoring and troubleshooting.
 */

import { statSync } from "node:fs";

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import { countConversations } from "../../memory/conversation-queries.js";
import { rawAll } from "../../memory/db.js";
import { getMemoryJobCounts } from "../../memory/jobs-store.js";
import {
  getProviderRoutingSource,
  listProviders,
} from "../../providers/registry.js";
import { countSchedules } from "../../schedule/schedule-store.js";
import { getDbPath } from "../../util/platform.js";
import type { RouteDefinition } from "../http-router.js";

/** Process start time — used to calculate uptime. */
const startedAt = Date.now();

function getDatabaseSizeBytes(): number | null {
  try {
    return statSync(getDbPath()).size;
  } catch {
    return null;
  }
}

function getMemoryItemCount(): number {
  try {
    const rows = rawAll<{ c: number }>(
      "SELECT COUNT(*) AS c FROM memory_graph_nodes",
    );
    return rows[0]?.c ?? 0;
  } catch {
    return 0;
  }
}

function handleDebug(): Response {
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - startedAt) / 1000);

  const conversationCount = countConversations();
  const memoryItemCount = getMemoryItemCount();
  const dbSizeBytes = getDatabaseSizeBytes();

  const memoryJobCounts = getMemoryJobCounts();

  const scheduleCounts = countSchedules();

  const config = getConfig();
  const registeredProviders = listProviders();
  const routingSources: Record<string, string | undefined> = {};
  for (const name of registeredProviders) {
    routingSources[name] = getProviderRoutingSource(name);
  }

  return Response.json({
    session: {
      uptimeSeconds,
      startedAt: new Date(startedAt).toISOString(),
    },
    provider: {
      configuredProvider: config.services.inference.provider,
      registeredProviders,
      routingSources,
      inferenceMode: config.services.inference.mode,
    },
    memory: {
      conversationCount,
      memoryItemCount,
      ...(dbSizeBytes != null ? { databaseSizeBytes: dbSizeBytes } : {}),
    },
    jobs: {
      memory: memoryJobCounts,
    },
    schedules: {
      total: scheduleCounts.total,
      enabled: scheduleCounts.enabled,
    },
    timestamp: new Date(now).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function debugRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "debug",
      method: "GET",
      summary: "Debug introspection",
      description:
        "Return runtime diagnostics: uptime, provider info, memory stats, job counts, and schedule counts.",
      tags: ["debug"],
      handler: () => handleDebug(),
      responseBody: z.object({
        session: z.object({}).passthrough().describe("Uptime and start time"),
        provider: z
          .object({})
          .passthrough()
          .describe("Inference provider configuration"),
        memory: z
          .object({})
          .passthrough()
          .describe("Conversation and memory item counts"),
        jobs: z.object({}).passthrough().describe("Background job counts"),
        schedules: z
          .object({})
          .passthrough()
          .describe("Schedule counts (total, enabled)"),
        timestamp: z.string().describe("Current server timestamp (ISO 8601)"),
      }),
    },
  ];
}
