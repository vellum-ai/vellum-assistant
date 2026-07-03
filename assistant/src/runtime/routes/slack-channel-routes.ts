import { z } from "zod";

import {
  conversationMetadataSyncTag,
  SYNC_TAGS,
} from "../../daemon/message-types/sync.js";
import {
  getSlackConversationInfo,
  SlackApiError,
} from "../../messaging/providers/slack/api.js";
import {
  getBindingByConversation,
  updateExternalChatName,
} from "../../persistence/external-conversation-store.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { publishSyncInvalidation } from "../sync/sync-publisher.js";
import { NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

type ResolveReason =
  | "auth"
  | "dm"
  | "no_name"
  | "not_found"
  | "permission"
  | "rate_limit"
  | "slack_error";

interface SlackChannelResolveResponse {
  channelId: string;
  channelName?: string;
  cached: boolean;
  resolved: boolean;
  reason?: ResolveReason;
}

const SlackChannelResolveResponseSchema = z.object({
  channelId: z.string(),
  channelName: z.string().optional(),
  cached: z.boolean(),
  resolved: z.boolean(),
  reason: z
    .enum([
      "auth",
      "dm",
      "no_name",
      "not_found",
      "permission",
      "rate_limit",
      "slack_error",
    ])
    .optional(),
});

function friendlyCachedName(
  externalChatId: string,
  externalChatName?: string | null,
): string | undefined {
  const trimmed = externalChatName?.trim();
  if (!trimmed || trimmed === externalChatId) return undefined;
  return trimmed;
}

function usableResolvedName(
  externalChatId: string,
  name?: string,
  nameNormalized?: string,
): string | undefined {
  for (const candidate of [name, nameNormalized]) {
    const trimmed = candidate?.trim();
    if (trimmed && trimmed !== externalChatId) return trimmed;
  }
  return undefined;
}

function reasonForSlackError(err: unknown): ResolveReason {
  if (err instanceof SlackApiError) {
    switch (err.category) {
      case "auth":
        return "auth";
      case "channel_not_found":
      case "not_found":
        return "not_found";
      case "permission":
        return "permission";
      case "rate_limit":
        return "rate_limit";
      default:
        return "slack_error";
    }
  }
  return "slack_error";
}

async function handleSlackChannelNameResolve({
  pathParams = {},
  headers,
}: RouteHandlerArgs): Promise<SlackChannelResolveResponse> {
  const conversationId = pathParams.conversationId?.trim();
  if (!conversationId) {
    throw new NotFoundError("Conversation not found");
  }

  const binding = getBindingByConversation(conversationId);

  if (!binding || binding.sourceChannel !== "slack") {
    throw new NotFoundError("Conversation not found");
  }

  const channelId = binding.externalChatId;
  const cachedName = friendlyCachedName(channelId, binding.externalChatName);
  if (cachedName) {
    return {
      channelId,
      channelName: cachedName,
      cached: true,
      resolved: true,
    };
  }

  if (channelId.startsWith("D")) {
    return {
      channelId,
      cached: false,
      resolved: false,
      reason: "dm",
    };
  }

  let info;
  try {
    info = await getSlackConversationInfo(channelId);
  } catch (err) {
    return {
      channelId,
      cached: false,
      resolved: false,
      reason: reasonForSlackError(err),
    };
  }

  const channelName = usableResolvedName(
    channelId,
    info?.name,
    info?.nameNormalized,
  );
  if (!channelName) {
    return {
      channelId,
      cached: false,
      resolved: false,
      reason: "no_name",
    };
  }

  updateExternalChatName(conversationId, channelName);
  await publishSyncInvalidation(
    [SYNC_TAGS.conversationsList, conversationMetadataSyncTag(conversationId)],
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  );

  return {
    channelId,
    channelName,
    cached: false,
    resolved: true,
  };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "slack_channel_name_resolve",
    endpoint: "conversations/:conversationId/slack-channel/resolve",
    method: "POST",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    handler: handleSlackChannelNameResolve,
    summary: "Resolve Slack channel name",
    description:
      "Resolve and persist a friendly Slack channel name for an external conversation binding.",
    tags: ["conversations", "slack"],
    pathParams: [
      {
        name: "conversationId",
        type: "string",
        description: "Conversation ID whose Slack channel name should resolve.",
      },
    ],
    responseBody: SlackChannelResolveResponseSchema,
  },
];
