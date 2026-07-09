import type { ContactRead } from "@vellumai/gateway-client/gateway-ipc-contracts";

import { cliIpcCall } from "../../../../ipc/cli-client.js";
import { resolveGuardianName } from "../../../../prompts/user-reference.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

function guardianAwareName(contact: Pick<ContactRead, "role" | "displayName">) {
  return contact.role === "guardian"
    ? resolveGuardianName(contact.displayName)
    : contact.displayName;
}

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
    cliIpcCall<{ contact: ContactRead }>("getContact", {
      pathParams: { id: keepId },
    }),
    cliIpcCall<{ contact: ContactRead }>("getContact", {
      pathParams: { id: mergeId },
    }),
  ]);

  if (!keepRes.ok) {
    return { content: `Error: ${keepRes.error}`, isError: true };
  }
  if (!mergeRes.ok) {
    return { content: `Error: ${mergeRes.error}`, isError: true };
  }

  const keepContact = keepRes.result!.contact;
  const mergeContact = mergeRes.result!.contact;

  const mergeResult = await cliIpcCall<{
    ok: boolean;
    contact: ContactRead;
  }>("merge_contacts", {
    body: { keepId, mergeId },
  });

  if (!mergeResult.ok) {
    return { content: `Error: ${mergeResult.error}`, isError: true };
  }

  const mergedId = mergeResult.result!.contact.id;

  // Re-read the surviving contact through the gateway-relayed read so role and
  // interactionCount come from the gateway ContactRead.
  const mergedRes = await cliIpcCall<{ contact: ContactRead }>("getContact", {
    pathParams: { id: mergedId },
  });

  if (!mergedRes.ok) {
    return { content: `Error: ${mergedRes.error}`, isError: true };
  }

  const merged = mergedRes.result!.contact;
  const displayName = guardianAwareName(merged);
  const keepName = guardianAwareName(keepContact);
  const mergeName = guardianAwareName(mergeContact);

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
      `  Interactions: ${merged.interactionCount ?? 0}`,
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
