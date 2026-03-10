/**
 * Tool for managing per-channel permission profiles in Slack.
 *
 * Allows the assistant to configure which tools are available in specific
 * Slack channels, set trust levels, and manage permission overrides.
 */

import {
  type ChannelPermissionProfile,
  getChannelPermissions,
  removeChannelPermissionProfile,
  setAllChannelPermissions,
  setChannelPermissionProfile,
} from "../../../../channels/permission-profiles.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const action = input.action as string;

  if (!action) {
    return err("action is required (list, get, set, remove, or clear).");
  }

  try {
    switch (action) {
      case "list": {
        const perms = getChannelPermissions();
        const entries = Object.entries(perms);
        if (entries.length === 0) {
          return ok(
            'No channel permission profiles configured. Use action "set" to configure permissions for a channel.',
          );
        }
        return ok(JSON.stringify({ channelPermissions: perms }, null, 2));
      }

      case "get": {
        const channelId = input.channel_id as string | undefined;
        if (!channelId) {
          return err('channel_id is required for "get" action.');
        }
        const perms = getChannelPermissions();
        const profile = perms[channelId];
        if (!profile) {
          return ok(
            JSON.stringify(
              {
                channel_id: channelId,
                profile: null,
                message: "No permission profile configured for this channel.",
              },
              null,
              2,
            ),
          );
        }
        return ok(JSON.stringify({ channel_id: channelId, profile }, null, 2));
      }

      case "set": {
        const channelId = input.channel_id as string | undefined;
        if (!channelId) {
          return err('channel_id is required for "set" action.');
        }

        const profile: ChannelPermissionProfile = {};

        if (typeof input.label === "string") {
          profile.label = input.label;
        }
        if (Array.isArray(input.allowed_tool_categories)) {
          profile.allowedToolCategories =
            input.allowed_tool_categories as string[];
        }
        if (Array.isArray(input.blocked_tools)) {
          profile.blockedTools = input.blocked_tools as string[];
        }
        if (
          input.trust_level === "restricted" ||
          input.trust_level === "standard"
        ) {
          profile.trustLevel = input.trust_level;
        }

        setChannelPermissionProfile(channelId, profile);
        return ok(
          JSON.stringify(
            {
              channel_id: channelId,
              profile,
              message: "Permission profile saved.",
            },
            null,
            2,
          ),
        );
      }

      case "remove": {
        const channelId = input.channel_id as string | undefined;
        if (!channelId) {
          return err('channel_id is required for "remove" action.');
        }
        const removed = removeChannelPermissionProfile(channelId);
        return ok(
          JSON.stringify(
            {
              channel_id: channelId,
              removed,
              message: removed
                ? "Permission profile removed."
                : "No permission profile found for this channel.",
            },
            null,
            2,
          ),
        );
      }

      case "clear": {
        setAllChannelPermissions({});
        return ok(
          JSON.stringify(
            { message: "All channel permission profiles cleared." },
            null,
            2,
          ),
        );
      }

      default:
        return err(
          `Unknown action "${action}". Use list, get, set, remove, or clear.`,
        );
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
