import { searchContacts } from "../../../../contacts/contact-store.js";
import type { ContactWithChannels } from "../../../../contacts/types.js";
import { resolveGuardianName } from "../../../../prompts/user-reference.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

function formatContactSummary(c: ContactWithChannels): string {
  const displayName =
    c.role === "guardian" ? resolveGuardianName(c.displayName) : c.displayName;
  const parts = [`- **${displayName}** (ID: ${c.id})`];
  if (c.notes) parts.push(`  Notes: ${c.notes}`);
  if (c.interactionCount > 0)
    parts.push(`  Interactions: ${c.interactionCount}`);
  if (c.channels.length > 0) {
    const channelList = c.channels
      .map((ch) => {
        let s = `${ch.type}:${ch.address}${ch.isPrimary ? "*" : ""}`;
        const extras: string[] = [];
        if (ch.externalUserId) extras.push(`userId: ${ch.externalUserId}`);
        if (ch.externalChatId) extras.push(`chatId: ${ch.externalChatId}`);
        if (extras.length > 0) s += ` (${extras.join(", ")})`;
        return s;
      })
      .join(", ");
    parts.push(`  Channels: ${channelList}`);
  }
  return parts.join("\n");
}

export async function executeContactSearch(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const query = input.query as string | undefined;
  const channelAddress = input.channel_address as string | undefined;
  const channelType = input.channel_type as string | undefined;
  const limit = input.limit as number | undefined;

  if (!query && !channelAddress) {
    return {
      content:
        "Error: At least one search criterion is required (query or channel_address)",
      isError: true,
    };
  }

  try {
    const results = searchContacts({
      query: query ?? undefined,
      channelAddress: channelAddress ?? undefined,
      channelType: channelType ?? undefined,
      limit: limit ?? undefined,
    });

    if (results.length === 0) {
      return {
        content: "No contacts found matching the search criteria.",
        isError: false,
      };
    }

    const lines = [`Found ${results.length} contact(s):\n`];
    for (const contact of results) {
      lines.push(formatContactSummary(contact));
    }

    return { content: lines.join("\n"), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

export { executeContactSearch as run };
