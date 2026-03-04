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
    const gatewayBase = getGatewayInternalBaseUrl();
    const token = mintEdgeRelayToken();
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };

    // Validate both contacts exist before merging
    const [keepResp, mergeResp] = await Promise.all([
      fetch(`${gatewayBase}/v1/contacts/${keepId}`, {
        method: "GET",
        headers,
      }),
      fetch(`${gatewayBase}/v1/contacts/${mergeId}`, {
        method: "GET",
        headers,
      }),
    ]);

    if (!keepResp.ok) {
      return { content: `Error: Contact "${keepId}" not found`, isError: true };
    }
    if (!mergeResp.ok) {
      return {
        content: `Error: Contact "${mergeId}" not found`,
        isError: true,
      };
    }

    const keepData = (await keepResp.json()) as {
      ok: boolean;
      contact: ContactResponse;
    };
    const mergeData = (await mergeResp.json()) as {
      ok: boolean;
      contact: ContactResponse;
    };
    const keepContact = keepData.contact;
    const mergeContact = mergeData.contact;

    // Execute the merge
    const mergeResult = await fetch(`${gatewayBase}/v1/contacts/merge`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ keepId, mergeId }),
    });

    if (!mergeResult.ok) {
      const body = await mergeResult.text();
      let message = `Gateway request failed (${mergeResult.status})`;
      try {
        const parsed = JSON.parse(body) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        if (body) message = body;
      }
      return { content: `Error: ${message}`, isError: true };
    }

    const resultData = (await mergeResult.json()) as {
      ok: boolean;
      contact: ContactResponse;
    };
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
