/**
 * Slack channel and user cache for the `use slack` CLI.
 *
 * Caches are persisted as JSON files under `<dataDir>/slack-use/` so that
 * channel/user resolution avoids redundant Slack API calls. The cache is
 * rebuilt on demand (first miss or explicit refresh).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  listConversations,
  listUsers,
} from "../../../../messaging/providers/slack/client.js";
import type { SlackConversation } from "../../../../messaging/providers/slack/types.js";
import { getDataDir } from "../../../../util/platform.js";
import { NotFoundError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlackChannelCache {
  workspace: string;
  refreshedAt: string;
  channels: Record<string, { id: string; type: string }>;
}

export interface SlackUserCache {
  workspace: string;
  refreshedAt: string;
  users: Record<string, { id: string; email?: string; displayName?: string }>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function channelCachePath(): string {
  return join(getDataDir(), "slack-use", "channels.json");
}

function userCachePath(): string {
  return join(getDataDir(), "slack-use", "users.json");
}

// ---------------------------------------------------------------------------
// Channel cache I/O
// ---------------------------------------------------------------------------

export function loadChannelCache(): SlackChannelCache | undefined {
  const p = channelCachePath();
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SlackChannelCache;
  } catch {
    return undefined;
  }
}

export function saveChannelCache(cache: SlackChannelCache): void {
  const p = channelCachePath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(cache, null, 2));
}

// ---------------------------------------------------------------------------
// User cache I/O
// ---------------------------------------------------------------------------

export function loadUserCache(): SlackUserCache | undefined {
  const p = userCachePath();
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SlackUserCache;
  } catch {
    return undefined;
  }
}

export function saveUserCache(cache: SlackUserCache): void {
  const p = userCachePath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(cache, null, 2));
}

// ---------------------------------------------------------------------------
// Channel resolution
// ---------------------------------------------------------------------------

function classifyConversation(conv: SlackConversation): string {
  if (conv.is_im) return "dm";
  if (conv.is_mpim) return "group";
  if (conv.is_group) return "group";
  return "channel";
}

/**
 * Fetch all channels from the Slack API (paginating), rebuild the channel
 * cache, persist it, and return it.
 */
export async function refreshChannelCache(
  token: string,
): Promise<SlackChannelCache> {
  const channels: Record<string, { id: string; type: string }> = {};
  let cursor: string | undefined;
  do {
    const resp = await listConversations(
      token,
      "public_channel,private_channel,mpim,im",
      true,
      200,
      cursor,
    );
    for (const ch of resp.channels) {
      const name = ch.name ?? ch.id;
      channels[name] = {
        id: ch.id,
        type: classifyConversation(ch),
      };
    }
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const cache: SlackChannelCache = {
    workspace: "default",
    refreshedAt: new Date().toISOString(),
    channels,
  };
  saveChannelCache(cache);
  return cache;
}

/**
 * Resolve a channel name or ID to a Slack channel ID.
 *
 * - If the input looks like a Slack channel ID (`C[A-Z0-9]+`), return it
 *   directly without any API calls.
 * - Otherwise check the local cache. On miss, refresh the cache from the
 *   Slack API and try again.
 * - Throws `NotFoundError` if the channel is not found after refresh.
 */
export async function resolveChannelId(
  token: string,
  nameOrId: string,
): Promise<string> {
  // Direct ID pass-through
  if (/^C[A-Z0-9]+$/.test(nameOrId)) {
    return nameOrId;
  }

  // Try cache first
  let cache = loadChannelCache();
  if (cache) {
    const entry = cache.channels[nameOrId];
    if (entry) return entry.id;
  }

  // Cache miss — refresh and retry
  cache = await refreshChannelCache(token);
  const entry = cache.channels[nameOrId];
  if (entry) return entry.id;

  throw new NotFoundError(`Slack channel not found: ${nameOrId}`);
}

// ---------------------------------------------------------------------------
// User resolution
// ---------------------------------------------------------------------------

/**
 * Fetch all users from the Slack API (paginating), rebuild the user cache,
 * persist it, and return it.
 */
export async function refreshUserCache(token: string): Promise<SlackUserCache> {
  const users: Record<
    string,
    { id: string; email?: string; displayName?: string }
  > = {};
  let cursor: string | undefined;
  do {
    const resp = await listUsers(token, 200, cursor);
    for (const member of resp.members) {
      if (member.deleted) continue;

      const displayName =
        member.profile?.display_name ||
        member.profile?.real_name ||
        member.real_name ||
        member.name;
      const email = member.profile?.email;

      // Key by display name (lowercased for case-insensitive lookup)
      users[displayName.toLowerCase()] = {
        id: member.id,
        email,
        displayName,
      };

      // Also key by email if available
      if (email) {
        users[email.toLowerCase()] = {
          id: member.id,
          email,
          displayName,
        };
      }
    }
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const cache: SlackUserCache = {
    workspace: "default",
    refreshedAt: new Date().toISOString(),
    users,
  };
  saveUserCache(cache);
  return cache;
}

/**
 * Resolve a user by display name or email to a Slack user ID.
 *
 * Checks the local cache first (case-insensitive). On miss, refreshes the
 * cache from the Slack API and retries. Throws `NotFoundError` if no match.
 */
export async function resolveUserId(
  token: string,
  nameOrEmail: string,
): Promise<{ id: string; email?: string; displayName?: string }> {
  const key = nameOrEmail.toLowerCase();

  // Try cache first
  let cache = loadUserCache();
  if (cache) {
    const entry = cache.users[key];
    if (entry) return entry;
  }

  // Cache miss — refresh and retry
  cache = await refreshUserCache(token);
  const entry = cache.users[key];
  if (entry) return entry;

  throw new NotFoundError(`Slack user not found: ${nameOrEmail}`);
}
