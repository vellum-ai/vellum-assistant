import {
  gatewayPost,
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

function formatContact(c: ContactResponse): string {
  const lines = [`Contact ${c.id}`, `  Name: ${c.displayName}`];
  if (c.notes) lines.push(`  Notes: ${c.notes}`);
  if (c.interactionCount > 0)
    lines.push(`  Interactions: ${c.interactionCount}`);
  if (c.channels.length > 0) {
    lines.push("  Channels:");
    for (const ch of c.channels) {
      const primary = ch.isPrimary ? " (primary)" : "";
      const extras: string[] = [];
      if (ch.externalUserId) extras.push(`userId: ${ch.externalUserId}`);
      if (ch.externalChatId) extras.push(`chatId: ${ch.externalChatId}`);
      const extrasStr = extras.length > 0 ? ` (${extras.join(", ")})` : "";
      lines.push(`    - ${ch.type}: ${ch.address}${primary}${extrasStr}`);
    }
  }
  return lines.join("\n");
}

export async function executeContactUpsert(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const displayName = input.display_name as string | undefined;
  if (
    !displayName ||
    typeof displayName !== "string" ||
    displayName.trim().length === 0
  ) {
    return {
      content: "Error: display_name is required and must be a non-empty string",
      isError: true,
    };
  }

  const rawChannels = input.channels as
    | Array<{
        type: string;
        address: string;
        is_primary?: boolean;
        external_user_id?: string;
        external_chat_id?: string;
      }>
    | undefined;
  const channels = rawChannels?.map((ch) => ({
    type: ch.type,
    address: ch.address,
    isPrimary: ch.is_primary,
    externalUserId: ch.external_user_id,
    externalChatId: ch.external_chat_id,
  }));

  try {
    const { status, data } = await gatewayPost<{
      ok: boolean;
      contact: ContactResponse;
    }>("/v1/contacts", {
      id: input.id as string | undefined,
      displayName: displayName.trim(),
      notes: input.notes as string | undefined,
      channels,
    });

    const created = status === 201;

    return {
      content: `${created ? "Created" : "Updated"} contact:\n${formatContact(data.contact)}`,
      isError: false,
    };
  } catch (err) {
    if (err instanceof GatewayRequestError) {
      return { content: `Error: ${err.message}`, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

export { executeContactUpsert as run };
