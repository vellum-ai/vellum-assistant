import type { ContactWithChannels } from "../../../../contacts/types.js";
import { cliIpcCall } from "../../../../ipc/cli-client.js";
import { resolveGuardianName } from "../../../../prompts/user-reference.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function executeContactMerge(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const keepId = input.keep_id as string | undefined;
  const mergeId = input.merge_id as string | undefined;

  if (!keepId || typeof keepId !== "string") {
    return { content: "Error: keep_id is required", isError: true };
  }
  if (!mergeId || typeof mergeId !== "string") {
    return { content: "Error: merge_id is required", isError: true };
  }

  // Validate both contacts exist before merging
  const [keepRes, mergeRes] = await Promise.all([
    cliIpcCall<ContactWithChannels | null>("get_contact", { id: keepId }),
    cliIpcCall<ContactWithChannels | null>("get_contact", { id: mergeId }),
  ]);

  if (!keepRes.ok) {
    return { content: `Error: ${keepRes.error}`, isError: true };
  }
  if (!keepRes.result) {
    return { content: `Error: Contact "${keepId}" not found`, isError: true };
  }
  if (!mergeRes.ok) {
    return { content: `Error: ${mergeRes.error}`, isError: true };
  }
  if (!mergeRes.result) {
    return { content: `Error: Contact "${mergeId}" not found`, isError: true };
  }

  const keepContact = keepRes.result;
  const mergeContact = mergeRes.result;

  const mergeResult = await cliIpcCall<ContactWithChannels>("merge_contacts", {
    keepId,
    mergeId,
  });

  if (!mergeResult.ok) {
    return { content: `Error: ${mergeResult.error}`, isError: true };
  }

  const merged = mergeResult.result!;
  const displayName =
    merged.role === "guardian"
      ? resolveGuardianName(merged.displayName)
      : merged.displayName;
  const keepName =
    keepContact.role === "guardian"
      ? resolveGuardianName(keepContact.displayName)
      : keepContact.displayName;
  const mergeName =
    mergeContact.role === "guardian"
      ? resolveGuardianName(mergeContact.displayName)
      : mergeContact.displayName;

  const channelList = merged.channels
    .map(
      (ch) =>
        `  - ${ch.type}: ${ch.address}${ch.isPrimary ? " (primary)" : ""}`,
    )
    .join("\n");

  return {
    content: [
      `Merged "${mergeName}" into "${keepName}".`,
      ``,
      `Surviving contact (${merged.id}):`,
      `  Name: ${displayName}`,
      `  Interactions: ${merged.interactionCount}`,
      merged.notes ? `  Notes: ${merged.notes}` : null,
      merged.channels.length > 0 ? `  Channels:\n${channelList}` : null,
      ``,
      `Deleted contact: ${mergeName} (${mergeId})`,
    ]
      .filter(Boolean)
      .join("\n"),
    isError: false,
  };
}

export { executeContactMerge as run };
