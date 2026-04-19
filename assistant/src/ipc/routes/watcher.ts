/**
 * IPC routes for watcher CRUD operations.
 *
 * Exposes create/list/update/delete/digest operations so CLI commands
 * and external processes can manage watchers via the daemon IPC socket.
 *
 * Each operation is registered under both a slash-style method name
 * (e.g. `watcher/create`) and an underscore alias (`watcher_create`).
 */

import { z } from "zod";

import {
  getWatcherProvider,
  listWatcherProviders,
} from "../../watcher/provider-registry.js";
import {
  createWatcher,
  deleteWatcher,
  getWatcher,
  listWatcherEvents,
  listWatchers,
  updateWatcher,
} from "../../watcher/watcher-store.js";
import type { IpcRoute } from "../cli-server.js";

// -- Param schemas ------------------------------------------------------------

const WatcherCreateParams = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  action_prompt: z.string().min(1),
  poll_interval_ms: z.number().int().min(15000).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  credential_service: z.string().optional(),
});

const WatcherListParams = z.object({
  watcher_id: z.string().optional(),
  enabled_only: z.boolean().optional().default(false),
});

const WatcherUpdateParams = z.object({
  watcher_id: z.string().min(1),
  name: z.string().optional(),
  action_prompt: z.string().optional(),
  poll_interval_ms: z.number().int().min(15000).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const WatcherDeleteParams = z.object({
  watcher_id: z.string().min(1),
});

const WatcherDigestParams = z.object({
  watcher_id: z.string().optional(),
  hours: z.number().positive().optional().default(24),
  limit: z.number().int().positive().optional().default(50),
});

// -- Handlers -----------------------------------------------------------------

function handleWatcherCreate(params?: Record<string, unknown>): unknown {
  const {
    name,
    provider: providerId,
    action_prompt: actionPrompt,
    poll_interval_ms: pollIntervalMs,
    config,
    credential_service: credentialServiceOverride,
  } = WatcherCreateParams.parse(params);

  const provider = getWatcherProvider(providerId);
  if (!provider) {
    const available =
      listWatcherProviders()
        .map((p) => p.id)
        .join(", ") || "none";
    throw new Error(
      `Unknown provider "${providerId}". Available: ${available}`,
    );
  }

  const credentialService =
    credentialServiceOverride ?? provider.requiredCredentialService;

  const watcher = createWatcher({
    name,
    providerId,
    actionPrompt,
    credentialService,
    pollIntervalMs,
    configJson: config ? JSON.stringify(config) : null,
  });

  return watcher;
}

function handleWatcherList(params?: Record<string, unknown>): unknown {
  const { watcher_id: watcherId, enabled_only: enabledOnly } =
    WatcherListParams.parse(params);

  if (watcherId) {
    const watcher = getWatcher(watcherId);
    if (!watcher) {
      throw new Error(`Watcher not found: ${watcherId}`);
    }
    const events = listWatcherEvents({ watcherId, limit: 10 });
    return { watcher, events };
  }

  return listWatchers({ enabledOnly });
}

function handleWatcherUpdate(params?: Record<string, unknown>): unknown {
  const {
    watcher_id: watcherId,
    name,
    action_prompt: actionPrompt,
    poll_interval_ms: pollIntervalMs,
    enabled,
    config,
  } = WatcherUpdateParams.parse(params);

  const updates: {
    name?: string;
    actionPrompt?: string;
    pollIntervalMs?: number;
    enabled?: boolean;
    configJson?: string | null;
  } = {};

  if (name !== undefined) updates.name = name;
  if (actionPrompt !== undefined) updates.actionPrompt = actionPrompt;
  if (pollIntervalMs !== undefined) updates.pollIntervalMs = pollIntervalMs;
  if (enabled !== undefined) updates.enabled = enabled;
  if (config !== undefined) updates.configJson = JSON.stringify(config);

  if (Object.keys(updates).length === 0) {
    throw new Error(
      "No updates provided. Specify at least one field to update.",
    );
  }

  const watcher = updateWatcher(watcherId, updates);
  if (!watcher) {
    throw new Error(`Watcher not found: ${watcherId}`);
  }

  return watcher;
}

function handleWatcherDelete(params?: Record<string, unknown>): unknown {
  const { watcher_id: watcherId } = WatcherDeleteParams.parse(params);

  const watcher = getWatcher(watcherId);
  if (!watcher) {
    throw new Error(`Watcher not found: ${watcherId}`);
  }

  deleteWatcher(watcherId);

  // Evict any in-process provider state (e.g. Linear issue-state cache)
  const provider = getWatcherProvider(watcher.providerId);
  provider?.cleanup?.(watcherId);

  return { deleted: true, name: watcher.name };
}

function handleWatcherDigest(params?: Record<string, unknown>): unknown {
  const {
    watcher_id: watcherId,
    hours,
    limit,
  } = WatcherDigestParams.parse(params);

  const since = Date.now() - hours * 3_600_000;
  const events = listWatcherEvents({ watcherId, limit, since });

  const allWatchers = listWatchers();
  const watcherNames: Record<string, string> = {};
  for (const w of allWatchers) {
    watcherNames[w.id] = w.name;
  }

  return { events, watcherNames };
}

// -- Route definitions --------------------------------------------------------

export const watcherRoutes: IpcRoute[] = [
  { method: "watcher/create", handler: handleWatcherCreate },
  { method: "watcher_create", handler: handleWatcherCreate },
  { method: "watcher/list", handler: handleWatcherList },
  { method: "watcher_list", handler: handleWatcherList },
  { method: "watcher/update", handler: handleWatcherUpdate },
  { method: "watcher_update", handler: handleWatcherUpdate },
  { method: "watcher/delete", handler: handleWatcherDelete },
  { method: "watcher_delete", handler: handleWatcherDelete },
  { method: "watcher/digest", handler: handleWatcherDigest },
  { method: "watcher_digest", handler: handleWatcherDigest },
];
