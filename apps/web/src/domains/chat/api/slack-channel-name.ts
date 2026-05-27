import { client, SDK_BASE_OPTIONS } from "@/domains/chat/api/client";

export interface SlackChannelNameResolution {
  channelId: string;
  channelName?: string;
  cached: boolean;
  resolved: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseResolution(value: unknown): SlackChannelNameResolution | null {
  const payload = asRecord(value);
  if (typeof payload?.channelId !== "string") {
    return null;
  }

  return {
    channelId: payload.channelId,
    channelName:
      typeof payload.channelName === "string" ? payload.channelName : undefined,
    cached: payload.cached === true,
    resolved: payload.resolved === true,
  };
}

export async function resolveSlackChannelName(
  assistantId: string,
  conversationId: string,
): Promise<SlackChannelNameResolution | null> {
  try {
    const { data, response } = await client.post<unknown, unknown>({
      ...SDK_BASE_OPTIONS,
      url: "/v1/assistants/{assistant_id}/conversations/{conversationId}/slack-channel/resolve",
      path: { assistant_id: assistantId, conversationId },
      body: {},
      throwOnError: false,
    });

    if (!response?.ok) {
      return null;
    }

    return parseResolution(data);
  } catch {
    return null;
  }
}
