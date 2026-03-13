import * as slack from "../../../../messaging/providers/slack/client.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getSlackConnection, ok } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const channelId = input.channel_id as string;

  if (!channelId) {
    return err("channel_id is required.");
  }

  try {
    const connection = getSlackConnection();
    const resp = await slack.conversationInfo(connection, channelId);
    const conv = resp.channel;

    const result = {
      channelId: conv.id,
      name: conv.name ?? conv.id,
      topic: conv.topic?.value || null,
      purpose: conv.purpose?.value || null,
      isPrivate: conv.is_private ?? conv.is_group ?? false,
      isArchived: conv.is_archived ?? false,
      memberCount: conv.num_members ?? null,
      latestActivityTs: conv.latest?.ts ?? null,
    };

    return ok(JSON.stringify(result, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
