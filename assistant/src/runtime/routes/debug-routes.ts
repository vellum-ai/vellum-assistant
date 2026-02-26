/**
 * Debug introspection endpoint for monitoring and troubleshooting.
 */

import { statSync } from 'node:fs';

import { getDbPath } from '../../util/platform.js';
import { countConversations } from '../../memory/conversation-store.js';
import { getMemoryJobCounts } from '../../memory/jobs-store.js';
import { listSchedules } from '../../schedule/schedule-store.js';
import { rawAll } from '../../memory/db.js';
import { getConfig } from '../../config/loader.js';
import { getProviderDebugStatus } from '../../providers/registry.js';

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
    const rows = rawAll<{ c: number }>('SELECT COUNT(*) AS c FROM memory_items');
    return rows[0]?.c ?? 0;
  } catch {
    return 0;
  }
}

export function handleDebug(): Response {
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - startedAt) / 1000);

  const conversationCount = countConversations();
  const memoryItemCount = getMemoryItemCount();
  const dbSizeBytes = getDatabaseSizeBytes();

  const memoryJobCounts = getMemoryJobCounts();

  const schedules = listSchedules();
  const enabledSchedules = schedules.filter((s) => s.enabled).length;

  const config = getConfig();
  const providerOrder = Array.isArray(config.providerOrder) ? config.providerOrder : [];
  const providerStatus = getProviderDebugStatus(config.provider, providerOrder);

  return Response.json({
    session: {
      uptimeSeconds,
      startedAt: new Date(startedAt).toISOString(),
    },
    provider: providerStatus,
    memory: {
      conversationCount,
      memoryItemCount,
      ...(dbSizeBytes != null ? { databaseSizeBytes: dbSizeBytes } : {}),
    },
    jobs: {
      memory: memoryJobCounts,
    },
    schedules: {
      total: schedules.length,
      enabled: enabledSchedules,
    },
    timestamp: new Date(now).toISOString(),
  });
}
