import {
  gatewayGet,
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
}

interface ContactResponse {
  id: string;
  displayName: string;
  relationship: string | null;
  importance: number;
  interactionCount: number;
  channels: ContactChannel[];
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

  try {
    // Validate both contacts exist before merging
    let keepData: { ok: boolean; contact: ContactResponse };
    let mergeData: { ok: boolean; contact: ContactResponse };

    try {
      [keepData, mergeData] = await Promise.all([
        gatewayGet<{ ok: boolean; contact: ContactResponse }>(
          `/v1/contacts/${keepId}`,
        ),
        gatewayGet<{ ok: boolean; contact: ContactResponse }>(
          `/v1/contacts/${mergeId}`,
        ),
      ]);
    } catch (err) {
      if (err instanceof GatewayRequestError) {
        // Determine which contact failed by retrying individually
        try {
          await gatewayGet(`/v1/contacts/${keepId}`);
        } catch {
          return {
            content: `Error: Contact "${keepId}" not found`,
            isError: true,
          };
        }
        return {
          content: `Error: Contact "${mergeId}" not found`,
          isError: true,
        };
      }
      throw err;
    }

    const keepContact = keepData.contact;
    const mergeContact = mergeData.contact;

    // Execute the merge
    const { data: resultData } = await gatewayPost<{
      ok: boolean;
      contact: ContactResponse;
    }>("/v1/contacts/merge", { keepId, mergeId });
    const merged = resultData.contact;

    const channelList = merged.channels
      .map(
        (ch) =>
          `  - ${ch.type}: ${ch.address}${ch.isPrimary ? " (primary)" : ""}`,
      )
      .join("\n");

    return {
      content: [
        `Merged "${mergeContact.displayName}" into "${keepContact.displayName}".`,
        ``,
        `Surviving contact (${merged.id}):`,
        `  Name: ${merged.displayName}`,
        `  Importance: ${merged.importance.toFixed(2)}`,
        `  Interactions: ${merged.interactionCount}`,
        merged.relationship ? `  Relationship: ${merged.relationship}` : null,
        merged.channels.length > 0 ? `  Channels:\n${channelList}` : null,
        ``,
        `Deleted contact: ${mergeContact.displayName} (${mergeId})`,
      ]
        .filter(Boolean)
        .join("\n"),
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${msg}`, isError: true };
  }
}

export { executeContactMerge as run };
