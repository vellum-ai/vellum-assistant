#!/usr/bin/env bun

/**
 * Local JSON caching for Slack channel and user resolution.
 * Caches are stored under $VELLUM_WORKSPACE_DIR/data/slack-skill/.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { slackRequest } from "./slack-client.js";

const CACHE_DIR = join(
  process.env.VELLUM_WORKSPACE_DIR ?? join(homedir(), ".vellum", "workspace"),
  "data",
  "slack-skill",
);
export const CHANNEL_CACHE_PATH = join(CACHE_DIR, "channels.json");
const USER_CACHE_PATH = join(CACHE_DIR, "users.json");

export interface SlackChannelCache {
  refreshedAt: string;
  channels: Record<string, { id: string; type: string }>;
}

export interface SlackUserCache {
  refreshedAt: string;
  users: Record<string, { id: string; email?: string; displayName?: string }>;
}

/** Load a JSON cache file, returning null if missing or corrupt. */
export function loadCache<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Save a JSON cache file, creating parent directories as needed. */
export function saveCache<T>(filePath: string, data: T): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/** Paginate /conversations.list and build the channel cache. */
export async function refreshChannelCache(): Promise<SlackChannelCache> {
  const channels: Record<string, { id: string; type: string }> = {};
  let cursor: string | undefined;

  do {
    const query: Record<string, string> = {
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: "true",
      limit: "200",
    };
    if (cursor) query.cursor = cursor;

    const resp = await slackRequest<{
      channels: Array<{
        id: string;
        name?: string;
        is_private?: boolean;
        is_mpim?: boolean;
        is_im?: boolean;
        user?: string;
      }>;
      response_metadata?: { next_cursor?: string };
    }>({ method: "GET", path: "/conversations.list", query });

    if (!resp.ok || !resp.data || !(resp.data as any).ok) {
      throw new Error(
        `Slack API error fetching conversations: ${JSON.stringify(resp.data)}`,
      );
    }

    for (const ch of resp.data.channels ?? []) {
      let type = "public_channel";
      if (ch.is_im) type = "im";
      else if (ch.is_mpim) type = "mpim";
      else if (ch.is_private) type = "private_channel";

      const name = ch.name ?? ch.id;
      channels[name.toLowerCase()] = { id: ch.id, type };
    }

    cursor = resp.data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const cache: SlackChannelCache = {
    refreshedAt: new Date().toISOString(),
    channels,
  };

  saveCache(CHANNEL_CACHE_PATH, cache);
  return cache;
}

/** Paginate /users.list and build the user cache. */
export async function refreshUserCache(): Promise<SlackUserCache> {
  const users: Record<
    string,
    { id: string; email?: string; displayName?: string }
  > = {};
  let cursor: string | undefined;

  do {
    const query: Record<string, string> = { limit: "200" };
    if (cursor) query.cursor = cursor;

    const resp = await slackRequest<{
      members: Array<{
        id: string;
        deleted: boolean;
        is_bot: boolean;
        profile: {
          display_name?: string;
          real_name?: string;
          email?: string;
        };
      }>;
      response_metadata?: { next_cursor?: string };
    }>({ method: "GET", path: "/users.list", query });

    if (!resp.ok || !resp.data || !(resp.data as any).ok) {
      throw new Error(
        `Slack API error fetching users: ${JSON.stringify(resp.data)}`,
      );
    }

    for (const member of resp.data.members ?? []) {
      if (member.deleted || member.is_bot) continue;

      const displayName =
        member.profile.display_name || member.profile.real_name || undefined;
      const email = member.profile.email || undefined;
      const entry = { id: member.id, email, displayName };

      if (displayName) {
        users[displayName.toLowerCase()] = entry;
      }
      if (email) {
        users[email.toLowerCase()] = entry;
      }
    }

    cursor = resp.data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const cache: SlackUserCache = {
    refreshedAt: new Date().toISOString(),
    users,
  };

  saveCache(USER_CACHE_PATH, cache);
  return cache;
}

const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]+$/;

/**
 * Resolve a channel by name or ID.
 * - Strips leading `#`
 * - Direct pass-through for IDs matching C/D/G prefix pattern
 * - Cache lookup (case-insensitive), auto-refresh on miss
 */
export async function resolveChannel(
  nameOrId: string,
): Promise<{ id: string; name: string; type: string }> {
  const input = nameOrId.startsWith("#") ? nameOrId.slice(1) : nameOrId;

  // Direct ID pass-through
  if (CHANNEL_ID_PATTERN.test(input)) {
    return { id: input, name: input, type: "unknown" };
  }

  const key = input.toLowerCase();

  // Try cached value first
  let cache = loadCache<SlackChannelCache>(CHANNEL_CACHE_PATH);
  if (cache?.channels[key]) {
    return {
      id: cache.channels[key].id,
      name: key,
      type: cache.channels[key].type,
    };
  }

  // Cache miss — refresh and retry
  cache = await refreshChannelCache();
  if (cache.channels[key]) {
    return {
      id: cache.channels[key].id,
      name: key,
      type: cache.channels[key].type,
    };
  }

  throw new Error(`Channel not found: ${nameOrId}`);
}

/**
 * Resolve a user by display name or email (case-insensitive).
 * Auto-refreshes cache on miss.
 */
export async function resolveUser(
  nameOrEmail: string,
): Promise<{ id: string; displayName?: string; email?: string }> {
  const key = nameOrEmail.toLowerCase();

  // Try cached value first
  let cache = loadCache<SlackUserCache>(USER_CACHE_PATH);
  if (cache?.users[key]) {
    const entry = cache.users[key];
    return { id: entry.id, displayName: entry.displayName, email: entry.email };
  }

  // Cache miss — refresh and retry
  cache = await refreshUserCache();
  if (cache.users[key]) {
    const entry = cache.users[key];
    return { id: entry.id, displayName: entry.displayName, email: entry.email };
  }

  throw new Error(`User not found: ${nameOrEmail}`);
}
