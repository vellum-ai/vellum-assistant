import {
  gatewayGet,
  GatewayRequestError,
} from "../../../../runtime/gateway-internal-client.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

interface ContactChannel {
  type: string;
  address: string;
  isPrimary: boolean;
  externalUserId?: string | null;
  externalChatId?: string | null;
}

interface ContactResponse {
  id: string;
  displayName: string;
  notes: string | null;
  interactionCount: number;
  channels: ContactChannel[];
}

function formatContactSummary(c: ContactResponse): string {
  const parts = [`- **${c.displayName}** (ID: ${c.id})`];
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
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (channelAddress) params.set("channelAddress", channelAddress);
    if (channelType) params.set("channelType", channelType);
    if (limit !== undefined) params.set("limit", String(limit));

    const qs = params.toString();
    const data = await gatewayGet<{ ok: boolean; contacts: ContactResponse[] }>(
      `/v1/contacts${qs ? `?${qs}` : ""}`,
    );
    const results = data.contacts;

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
    if (err instanceof GatewayRequestError) {
      const message = err.gatewayError ?? err.message;
      return { content: `Error: ${message}`, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

export { executeContactSearch as run };
