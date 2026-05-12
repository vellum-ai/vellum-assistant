/**
 * Route handlers for the `use slack` CLI.
 *
 * These endpoints expose channel/user resolution and cache management
 * over the daemon IPC/HTTP interface so the CLI can perform Slack
 * operations without embedding API logic.
 */

import {
  addReaction,
  conversationHistory,
  conversationReplies,
  conversationsOpen,
  postMessage,
} from "../../../../messaging/providers/slack/client.js";
import { BadRequestError, ServiceUnavailableError } from "../../errors.js";
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
// POST use/slack/send — send a message to a channel or DM
// ---------------------------------------------------------------------------

async function handleSend({ body }: RouteHandlerArgs) {
  const channel = body?.channel as string | undefined;
  const user = body?.user as string | undefined;
  const text = body?.text as string | undefined;
  const thread = body?.thread as string | undefined;

  if (!text) {
    throw new BadRequestError("text is required");
  }

  if ((channel && user) || (!channel && !user)) {
    throw new BadRequestError("Exactly one of channel or user must be set");
  }

  const writeToken = await resolveSlackToken("write");
  if (!writeToken) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  let targetChannelId: string;

  if (channel) {
    const readToken = await resolveSlackToken("read");
    if (!readToken) {
      throw new ServiceUnavailableError("No Slack token configured");
    }
    targetChannelId = await resolveChannelId(readToken, channel);
  } else {
    // DM — resolve user then open a conversation
    const readToken = await resolveSlackToken("read");
    if (!readToken) {
      throw new ServiceUnavailableError("No Slack token configured");
    }
    const resolved = await resolveUserId(readToken, user!);
    const dmResp = await conversationsOpen(writeToken, resolved.id);
    targetChannelId = dmResp.channel.id;
  }

  const resp = await postMessage(writeToken, targetChannelId, text, {
    threadTs: thread,
  });
  return { ok: true, channel: resp.channel, ts: resp.ts };
}

// ---------------------------------------------------------------------------
// POST use/slack/read — read messages from a channel or thread
// ---------------------------------------------------------------------------

async function handleRead({ body }: RouteHandlerArgs) {
  const channel = body?.channel as string | undefined;
  const limit = body?.limit as number | undefined;
  const since = body?.since as string | undefined;
  const thread = body?.thread as string | undefined;

  if (!channel) {
    throw new BadRequestError("channel is required");
  }

  const token = await resolveSlackToken("read");
  if (!token) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  const channelId = await resolveChannelId(token, channel);

  // Parse `since` into a Slack timestamp (oldest)
  let oldest: string | undefined;
  if (since) {
    if (/^\d+\.\d+$/.test(since)) {
      // Already a Slack timestamp
      oldest = since;
    } else if (/^\d+[hmd]$/.test(since)) {
      // Relative offset: e.g. "2h", "30m", "1d"
      const value = parseInt(since.slice(0, -1), 10);
      const unit = since.slice(-1);
      let offsetMs: number;
      switch (unit) {
        case "h":
          offsetMs = value * 60 * 60 * 1000;
          break;
        case "m":
          offsetMs = value * 60 * 1000;
          break;
        case "d":
          offsetMs = value * 24 * 60 * 60 * 1000;
          break;
        default:
          throw new BadRequestError(
            `Invalid since unit: ${unit}. Use h, m, or d`,
          );
      }
      const ts = (Date.now() - offsetMs) / 1000;
      oldest = `${Math.floor(ts)}.000000`;
    } else {
      throw new BadRequestError(
        'Invalid since format. Use a Slack timestamp (e.g. "1234567890.123456") or a relative offset (e.g. "2h", "30m", "1d")',
      );
    }
  }

  let messages: Array<{
    ts: string;
    user?: string;
    text: string;
    thread_ts?: string;
  }>;

  if (thread) {
    const resp = await conversationReplies(
      token,
      channelId,
      thread,
      limit ?? 50,
      undefined,
      oldest,
    );
    messages = resp.messages.map((m) => ({
      ts: m.ts,
      user: m.user,
      text: m.text,
      thread_ts: m.thread_ts,
    }));
  } else {
    const resp = await conversationHistory(
      token,
      channelId,
      limit ?? 50,
      undefined,
      oldest,
    );
    messages = resp.messages.map((m) => ({
      ts: m.ts,
      user: m.user,
      text: m.text,
      thread_ts: m.thread_ts,
    }));
  }

  return { channel: channelId, messages };
}

// ---------------------------------------------------------------------------
// POST use/slack/react — add a reaction to a message
// ---------------------------------------------------------------------------

async function handleReact({ body }: RouteHandlerArgs) {
  const channel = body?.channel as string | undefined;
  const ts = body?.ts as string | undefined;
  let emoji = body?.emoji as string | undefined;

  if (!channel) {
    throw new BadRequestError("channel is required");
  }
  if (!ts) {
    throw new BadRequestError("ts is required");
  }
  if (!emoji) {
    throw new BadRequestError("emoji is required");
  }

  // Strip surrounding colons if present (e.g. ":thumbsup:" -> "thumbsup")
  emoji = emoji.replace(/^:/, "").replace(/:$/, "");

  const writeToken = await resolveSlackToken("write");
  if (!writeToken) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  const readToken = await resolveSlackToken("read");
  if (!readToken) {
    throw new ServiceUnavailableError("No Slack token configured");
  }

  const channelId = await resolveChannelId(readToken, channel);
  await addReaction(writeToken, channelId, ts, emoji);

  return { ok: true };
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
  {
    operationId: "slack_use_send",
    endpoint: "use/slack/send",
    method: "POST",
    summary: "Send a Slack message",
    description:
      "Send a message to a Slack channel or user DM. Exactly one of channel or user must be set. Supports threading via the thread parameter.",
    tags: ["integrations"],
    handler: handleSend,
  },
  {
    operationId: "slack_use_read",
    endpoint: "use/slack/read",
    method: "POST",
    summary: "Read Slack messages",
    description:
      'Read messages from a Slack channel or thread. Supports limit, since (Slack timestamp or relative offset like "2h", "30m", "1d"), and thread replies.',
    tags: ["integrations"],
    handler: handleRead,
  },
  {
    operationId: "slack_use_react",
    endpoint: "use/slack/react",
    method: "POST",
    summary: "Add a reaction to a Slack message",
    description:
      "Add an emoji reaction to a message. Strips surrounding colons from the emoji name if present.",
    tags: ["integrations"],
    handler: handleReact,
  },
];
