/**
 * Debug introspection endpoint for monitoring and troubleshooting.
 */

import { statSync } from "node:fs";

import { z } from "zod";

import { resolveCallSiteConfig } from "../../config/llm-resolver.js";
import { getConfig } from "../../config/loader.js";
import { countConversations } from "../../persistence/conversation-queries.js";
import { getMemoryJobCounts } from "../../persistence/jobs-store.js";
import { rawAll } from "../../persistence/raw-query.js";
import {
  getProviderRoutingSource,
  listProviders,
} from "../../providers/registry.js";
import { countSchedules } from "../../schedule/schedule-store.js";
import { getDbPath } from "../../util/platform.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition } from "./types.js";

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
      "debug:getMemoryItemCount",
      "SELECT COUNT(*) AS c FROM memory_graph_nodes",
    );
    return rows[0]?.c ?? 0;
  } catch {
    return 0;
  }
}

function getDebugInfo() {
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - startedAt) / 1000);

  // Debug view counts every standard conversation, archived or not, so the
  // diagnostics report doesn't undercount after the route-level default
  // moved to "active".
  const conversationCount = countConversations("standard", "all");
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

  return {
    session: {
      uptimeSeconds,
      startedAt: new Date(startedAt).toISOString(),
    },
    provider: {
      configuredProvider: resolveCallSiteConfig("mainAgent", config.llm)
        .provider,
      registeredProviders,
      routingSources,
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
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "debug",
    endpoint: "debug",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: getDebugInfo,
    summary: "Debug introspection",
    description:
      "Return runtime diagnostics: uptime, provider info, memory stats, job counts, and schedule counts.",
    tags: ["debug"],
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
