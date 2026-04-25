/**
 * Channel-scoped permission profiles.
 *
 * Maps Slack channel IDs to permission/trust overrides. When processing
 * an inbound message from a channel, the permission profile is looked up
 * to determine which tools are available, what trust level applies, etc.
 *
 * Permission profiles are stored in the Slack skill config section:
 *   skills.entries.slack.config.channelPermissions
 *
 * Each entry maps a channel ID to a ChannelPermissionProfile.
 */

import { getConfig } from "../config/loader.js";

// ── Types ───────────────────────────────────────────────────────────

export interface ChannelPermissionProfile {
  /** Human-readable label for this channel's permission set. */
  label?: string;
  /** Tool categories allowed in this channel. When set, only tools in these
   *  categories can be invoked. Empty array means no tool restrictions. */
  allowedToolCategories?: string[];
  /** Specific tool names blocked in this channel, regardless of category. */
  blockedTools?: string[];
  /** Trust level override for messages from this channel.
   *  "restricted" limits tool access; "standard" uses defaults. */
  trustLevel?: "restricted" | "standard";
}

export type ChannelPermissionMap = Record<string, ChannelPermissionProfile>;

// ── Config accessors ────────────────────────────────────────────────

/**
 * Get all channel permission mappings from config.
 */
function getChannelPermissions(): ChannelPermissionMap {
  const config = getConfig();
  const perms = config.skills?.entries?.slack?.config?.channelPermissions;
  if (perms && typeof perms === "object" && !Array.isArray(perms)) {
    return perms as ChannelPermissionMap;
  }
  return {};
}

/**
 * Get the permission profile for a specific channel.
 * Returns null if no profile is configured for the channel.
 */
export function getChannelPermissionProfile(
  channelId: string,
): ChannelPermissionProfile | null {
  const perms = getChannelPermissions();
  return perms[channelId] ?? null;
}

// ── Permission resolution ───────────────────────────────────────────

/**
 * Check whether a specific tool is allowed in a channel.
 * If no permission profile exists for the channel, all tools are allowed.
 */
export function isToolAllowedInChannel(
  channelId: string,
  toolName: string,
  toolCategory?: string,
): boolean {
  const profile = getChannelPermissionProfile(channelId);
  if (!profile) return true;

  // Check explicit block list first
  if (profile.blockedTools?.includes(toolName)) return false;

  // Check allowed categories (if specified)
  if (
    profile.allowedToolCategories &&
    profile.allowedToolCategories.length > 0
  ) {
    if (!toolCategory) return false;
    return profile.allowedToolCategories.includes(toolCategory);
  }

  return true;
}
