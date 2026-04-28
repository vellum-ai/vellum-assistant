/**
 * Transport-agnostic routes for watcher CRUD operations.
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
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Param schemas ─────────────────────────────────────────────────────

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

// ── Response schemas ──────────────────────────────────────────────────

const WatcherResponse = z.object({}).passthrough();

// ── Handlers ──────────────────────────────────────────────────────────

function handleWatcherCreate({ body = {} }: RouteHandlerArgs) {
  const {
    name,
    provider: providerId,
    action_prompt: actionPrompt,
    poll_interval_ms: pollIntervalMs,
    config,
    credential_service: credentialServiceOverride,
  } = WatcherCreateParams.parse(body);

  const provider = getWatcherProvider(providerId);
  if (!provider) {
    const available =
      listWatcherProviders()
        .map((p) => p.id)
        .join(", ") || "none";
    throw new BadRequestError(
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

function handleWatcherList({ body = {} }: RouteHandlerArgs) {
  const { watcher_id: watcherId, enabled_only: enabledOnly } =
    WatcherListParams.parse(body);

  if (watcherId) {
    const watcher = getWatcher(watcherId);
    if (!watcher) {
      throw new NotFoundError(`Watcher not found: ${watcherId}`);
    }
    const events = listWatcherEvents({ watcherId, limit: 10 });
    return { watcher, events };
  }

  return listWatchers({ enabledOnly });
}

function handleWatcherUpdate({ body = {} }: RouteHandlerArgs) {
  const {
    watcher_id: watcherId,
    name,
    action_prompt: actionPrompt,
    poll_interval_ms: pollIntervalMs,
    enabled,
    config,
  } = WatcherUpdateParams.parse(body);

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
    throw new BadRequestError(
      "No updates provided. Specify at least one field to update.",
    );
  }

  const watcher = updateWatcher(watcherId, updates);
  if (!watcher) {
    throw new NotFoundError(`Watcher not found: ${watcherId}`);
  }

  return watcher;
}

function handleWatcherDelete({ body = {} }: RouteHandlerArgs) {
  const { watcher_id: watcherId } = WatcherDeleteParams.parse(body);

  const watcher = getWatcher(watcherId);
  if (!watcher) {
    throw new NotFoundError(`Watcher not found: ${watcherId}`);
  }

  deleteWatcher(watcherId);

  const provider = getWatcherProvider(watcher.providerId);
  provider?.cleanup?.(watcherId);

  return { deleted: true, name: watcher.name };
}

function handleWatcherDigest({ body = {} }: RouteHandlerArgs) {
  const {
    watcher_id: watcherId,
    hours,
    limit,
  } = WatcherDigestParams.parse(body);

  const since = Date.now() - hours * 3_600_000;
  const events = listWatcherEvents({ watcherId, limit, since });

  const allWatchers = listWatchers();
  const watcherNames: Record<string, string> = {};
  for (const w of allWatchers) {
    watcherNames[w.id] = w.name;
  }

  return { events, watcherNames };
}

// ── Route definitions ─────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "watcher_create",
    endpoint: "watchers/create",
    method: "POST",
    handler: handleWatcherCreate,
    summary: "Create a watcher",
    description: "Create a new watcher with a provider and action prompt.",
    tags: ["watchers"],
    requestBody: WatcherCreateParams,
    responseBody: WatcherResponse,
  },
  {
    operationId: "watcher_list",
    endpoint: "watchers/list",
    method: "POST",
    handler: handleWatcherList,
    summary: "List watchers",
    description:
      "List all watchers, or get details for a specific watcher by ID.",
    tags: ["watchers"],
    requestBody: WatcherListParams,
    responseBody: WatcherResponse,
  },
  {
    operationId: "watcher_update",
    endpoint: "watchers/update",
    method: "POST",
    handler: handleWatcherUpdate,
    summary: "Update a watcher",
    description: "Update an existing watcher's configuration.",
    tags: ["watchers"],
    requestBody: WatcherUpdateParams,
    responseBody: WatcherResponse,
  },
  {
    operationId: "watcher_delete",
    endpoint: "watchers/delete",
    method: "POST",
    handler: handleWatcherDelete,
    summary: "Delete a watcher",
    description: "Delete a watcher by ID.",
    tags: ["watchers"],
    requestBody: WatcherDeleteParams,
    responseBody: WatcherResponse,
  },
  {
    operationId: "watcher_digest",
    endpoint: "watchers/digest",
    method: "POST",
    handler: handleWatcherDigest,
    summary: "Get watcher event digest",
    description:
      "Get recent watcher events, optionally filtered by watcher ID.",
    tags: ["watchers"],
    requestBody: WatcherDigestParams,
    responseBody: WatcherResponse,
  },
];
