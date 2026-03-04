import { getGatewayInternalBaseUrl } from "../../../../config/env.js";
import { mintEdgeRelayToken } from "../../../../runtime/auth/token-service.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

interface ContactChannel {
  type: string;
  address: string;
  isPrimary: boolean;
}

interface ContactResponse {
  id: string;
  displayName: string;
  relationship: string | null;
  importance: number;
  interactionCount: number;
  channels: ContactChannel[];
}

function formatContactSummary(c: ContactResponse): string {
  const parts = [`- **${c.displayName}** (ID: ${c.id})`];
  if (c.relationship) parts.push(`  Relationship: ${c.relationship}`);
  parts.push(
    `  Importance: ${c.importance.toFixed(2)} | Interactions: ${
      c.interactionCount
    }`,
  );
  if (c.channels.length > 0) {
    const channelList = c.channels
      .map((ch) => `${ch.type}:${ch.address}${ch.isPrimary ? "*" : ""}`)
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
  const relationship = input.relationship as string | undefined;
  const limit = input.limit as number | undefined;

  if (!query && !channelAddress && !relationship) {
    return {
      content:
        "Error: At least one search criterion is required (query, channel_address, or relationship)",
      isError: true,
    };
  }

  try {
    const gatewayBase = getGatewayInternalBaseUrl();
    const token = mintEdgeRelayToken();

    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (channelAddress) params.set("channelAddress", channelAddress);
    if (channelType) params.set("channelType", channelType);
    if (relationship) params.set("relationship", relationship);
    if (limit !== undefined) params.set("limit", String(limit));

    const qs = params.toString();
    const url = `${gatewayBase}/v1/contacts${qs ? `?${qs}` : ""}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      let message = `Gateway request failed (${resp.status})`;
      try {
        const parsed = JSON.parse(body) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        if (body) message = body;
      }
      return { content: `Error: ${message}`, isError: true };
    }

    const data = (await resp.json()) as {
      ok: boolean;
      contacts: ContactResponse[];
    };
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
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

export { executeContactSearch as run };
