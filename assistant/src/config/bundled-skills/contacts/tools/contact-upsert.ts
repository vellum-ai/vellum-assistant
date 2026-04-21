import type { ContactWithChannels } from "../../../../contacts/types.js";
import { cliIpcCall } from "../../../../ipc/cli-client.js";
import { resolveGuardianName } from "../../../../prompts/user-reference.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

function formatContact(c: ContactWithChannels): string {
  const displayName =
    c.role === "guardian" ? resolveGuardianName(c.displayName) : c.displayName;
  const lines = [`Contact ${c.id}`, `  Name: ${displayName}`];
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
      }>
    | undefined;
  const channels = rawChannels?.map((ch) => ({
    type: ch.type,
    address: ch.address,
    isPrimary: ch.is_primary,
  }));

  const res = await cliIpcCall<ContactWithChannels & { created: boolean }>(
    "upsert_contact",
    {
      id: input.id as string | undefined,
      displayName: displayName.trim(),
      notes: input.notes as string | undefined,
      channels,
    },
  );

  if (!res.ok) {
    return { content: `Error: ${res.error}`, isError: true };
  }

  const contact = res.result!;
  const verb = contact.created ? "Created" : "Updated";

  return {
    content: `${verb} contact:\n${formatContact(contact)}`,
    isError: false,
  };
}

export { executeContactUpsert as run };
