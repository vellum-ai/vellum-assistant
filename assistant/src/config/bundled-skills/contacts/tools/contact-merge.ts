import type { ContactRead } from "@vellumai/gateway-client/gateway-ipc-contracts";

import { cliIpcCall } from "../../../../ipc/cli-client.js";
import { resolveGuardianName } from "../../../../prompts/user-reference.js";
import { throwIfCancelled } from "../../../../tools/shared/abort.js";
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
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const keepId = input.keep_id as string | undefined;
  const mergeId = input.merge_id as string | undefined;

  if (!keepId || typeof keepId !== "string") {
    return { content: "Error: keep_id is required", isError: true };
  }
  if (!mergeId || typeof mergeId !== "string") {
    return { content: "Error: merge_id is required", isError: true };
  }
  throwIfCancelled(context);

  // Validate both contacts exist before merging
  const [keepRes, mergeRes] = await Promise.all([
    cliIpcCall<{ contact: ContactRead }>(
      "getContact",
      { pathParams: { id: keepId } },
      { signal: context.signal },
    ),
    cliIpcCall<{ contact: ContactRead }>(
      "getContact",
      { pathParams: { id: mergeId } },
      { signal: context.signal },
    ),
  ]);

  if (!keepRes.ok) {
    return { content: `Error: ${keepRes.error}`, isError: true };
  }
  if (!mergeRes.ok) {
    return { content: `Error: ${mergeRes.error}`, isError: true };
  }

  const keepContact = keepRes.result!.contact;
  const mergeContact = mergeRes.result!.contact;

  // Recheck: the two existence lookups above are awaits, so a cancel landing
  // in either must not reach the merge.
  throwIfCancelled(context);

  // Deliberately detached from the turn signal. `cliIpcCall` cancels only the
  // client socket, so an abort after the request is on the wire resolves
  // "Request aborted" here while the route and the gateway finish the merge
  // regardless. That quick resolution would settle inside the loop's abort
  // grace and hand the model an ordinary failure for a merge that destroyed a
  // contact. Staying attached leaves the call unsettled instead, which is what
  // makes the loop say the work may still have completed.
  const mergeResult = await cliIpcCall<{
    ok: boolean;
    contact?: ContactRead;
  }>("merge_contacts", { body: { keepId, mergeId } });

  if (!mergeResult.ok) {
    return { content: `Error: ${mergeResult.error}`, isError: true };
  }

  // The merge response may omit the survivor (post-merge read-back can
  // degrade); the id we asked to keep is authoritative either way.
  const mergedId = mergeResult.result?.contact?.id ?? keepId;

  // Re-read the surviving contact through the gateway-relayed read so role and
  // interactionCount come from the gateway ContactRead. Detached from the turn
  // signal for the same reason as the merge above: the destructive step has
  // already run, so aborting the read here would report a failure for work that
  // succeeded.
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
