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
  notes: string | null;
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
    const [keepResult, mergeResult] = await Promise.allSettled([
      gatewayGet<{ ok: boolean; contact: ContactResponse }>(
        `/v1/contacts/${keepId}`,
      ),
      gatewayGet<{ ok: boolean; contact: ContactResponse }>(
        `/v1/contacts/${mergeId}`,
      ),
    ]);

    if (keepResult.status === "rejected") {
      if (
        keepResult.reason instanceof GatewayRequestError &&
        keepResult.reason.statusCode === 404
      ) {
        return {
          content: `Error: Contact "${keepId}" not found`,
          isError: true,
        };
      }
      throw keepResult.reason;
    }
    if (mergeResult.status === "rejected") {
      if (
        mergeResult.reason instanceof GatewayRequestError &&
        mergeResult.reason.statusCode === 404
      ) {
        return {
          content: `Error: Contact "${mergeId}" not found`,
          isError: true,
        };
      }
      throw mergeResult.reason;
    }

    const keepContact = keepResult.value.contact;
    const mergeContact = mergeResult.value.contact;

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
        `  Interactions: ${merged.interactionCount}`,
        merged.notes ? `  Notes: ${merged.notes}` : null,
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
