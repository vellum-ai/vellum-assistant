import { getConfig, saveConfig } from "../../../../config/loader.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok } from "./shared.js";

function getPreferredChannels(): string[] {
  const config = getConfig();
  const channels = config.skills?.entries?.slack?.config?.preferredChannels;
  return Array.isArray(channels) ? (channels as string[]) : [];
}

function setPreferredChannels(channels: string[]): void {
  const config = getConfig();
  if (!config.skills) config.skills = {} as typeof config.skills;
  if (!config.skills.entries) config.skills.entries = {};
  if (!config.skills.entries.slack)
    config.skills.entries.slack = { enabled: true };
  if (!config.skills.entries.slack.config)
    config.skills.entries.slack.config = {};
  config.skills.entries.slack.config.preferredChannels = channels;
  saveConfig(config);
}

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const action = input.action as string;
  const channelIds = input.channel_ids as string[] | undefined;

  if (!action) {
    return err("action is required (list, add, remove, or set).");
  }

  try {
    switch (action) {
      case "list": {
        const channels = getPreferredChannels();
        if (channels.length === 0) {
          return ok(
            'No preferred channels configured. Use action "set" or "add" to configure channels.',
          );
        }
        return ok(JSON.stringify({ preferredChannels: channels }, null, 2));
      }

      case "add": {
        if (!channelIds?.length) {
          return err('channel_ids required for "add" action.');
        }
        const current = getPreferredChannels();
        const merged = [...new Set([...current, ...channelIds])];
        setPreferredChannels(merged);
        return ok(
          JSON.stringify(
            {
              preferredChannels: merged,
              added: channelIds.filter((id) => !current.includes(id)),
            },
            null,
            2,
          ),
        );
      }

      case "remove": {
        if (!channelIds?.length) {
          return err('channel_ids required for "remove" action.');
        }
        const current = getPreferredChannels();
        const removeSet = new Set(channelIds);
        const remaining = current.filter((id) => !removeSet.has(id));
        setPreferredChannels(remaining);
        return ok(
          JSON.stringify(
            {
              preferredChannels: remaining,
              removed: channelIds.filter((id) => current.includes(id)),
            },
            null,
            2,
          ),
        );
      }

      case "set": {
        if (!channelIds) {
          return err('channel_ids required for "set" action.');
        }
        const unique = [...new Set(channelIds)];
        setPreferredChannels(unique);
        return ok(JSON.stringify({ preferredChannels: unique }, null, 2));
      }

      default:
        return err(
          `Unknown action "${action}". Use list, add, remove, or set.`,
        );
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
