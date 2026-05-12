/**
 * Route handlers for the `use slack` CLI.
 *
 * These endpoints expose channel/user resolution and cache management
 * over the daemon IPC/HTTP interface so the CLI can perform Slack
 * operations without embedding API logic.
 */

import { ServiceUnavailableError } from "../../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../../types.js";
import { resolveSlackToken } from "./token.js";
import {
  loadChannelCache,
  refreshChannelCache,
  resolveChannelId,
  resolveUserId,
} from "./use-slack-cache.js";

// ---------------------------------------------------------------------------
// GET use/slack/channels — list cached channels (auto-refresh on empty)
// ---------------------------------------------------------------------------

async function handleListChannels() {
  const token = await resolveSlackToken("read");
  if (!token) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  let cache = loadChannelCache();
  if (!cache || Object.keys(cache.channels).length === 0) {
    cache = await refreshChannelCache(token);
  }

  return cache;
}

// ---------------------------------------------------------------------------
// POST use/slack/channels/refresh — force-refresh channel cache
// ---------------------------------------------------------------------------

async function handleRefreshChannels() {
  const token = await resolveSlackToken("read");
  if (!token) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  const cache = await refreshChannelCache(token);
  return cache;
}

// ---------------------------------------------------------------------------
// GET use/slack/channels/:name — resolve a single channel by name
// ---------------------------------------------------------------------------

async function handleGetChannel({ pathParams }: RouteHandlerArgs) {
  const token = await resolveSlackToken("read");
  if (!token) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  const name = pathParams?.name ?? "";
  const id = await resolveChannelId(token, name);

  // Look up the full entry from cache for the type field
  const cache = loadChannelCache();
  const entry = cache
    ? Object.entries(cache.channels).find(([, v]) => v.id === id)
    : undefined;

  return {
    id,
    name: entry ? entry[0] : name,
    type: entry ? entry[1].type : "channel",
  };
}

// ---------------------------------------------------------------------------
// GET use/slack/users/:query — resolve a user by display name or email
// ---------------------------------------------------------------------------

async function handleGetUser({ pathParams }: RouteHandlerArgs) {
  const token = await resolveSlackToken("read");
  if (!token) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  const query = pathParams?.query ?? "";
  const user = await resolveUserId(token, query);

  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
  };
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "slack_use_channels_list",
    endpoint: "use/slack/channels",
    method: "GET",
    summary: "List cached Slack channels",
    description:
      "Return the cached channel list. Auto-refreshes from the Slack API if the cache is empty.",
    tags: ["integrations"],
    handler: () => handleListChannels(),
  },
  {
    operationId: "slack_use_channels_refresh",
    endpoint: "use/slack/channels/refresh",
    method: "POST",
    summary: "Refresh Slack channel cache",
    description:
      "Fetch all channels from the Slack API, rebuild the local cache, and return it.",
    tags: ["integrations"],
    handler: () => handleRefreshChannels(),
  },
  {
    operationId: "slack_use_channels_get",
    endpoint: "use/slack/channels/:name",
    method: "GET",
    summary: "Resolve a Slack channel by name",
    description:
      "Resolve a channel name (or raw Slack ID) to a structured channel object via the local cache.",
    tags: ["integrations"],
    handler: handleGetChannel,
  },
  {
    operationId: "slack_use_users_get",
    endpoint: "use/slack/users/:query",
    method: "GET",
    summary: "Resolve a Slack user by name or email",
    description:
      "Resolve a display name or email address to a Slack user via the local cache.",
    tags: ["integrations"],
    handler: handleGetUser,
  },
];
