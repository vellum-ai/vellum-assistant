/**
 * Conversation workspace-commands grants.
 *
 * GET/PUT /v1/conversations/:id/workspace-commands
 * CLI variants accept a conversation id or a Slack channel/user lookup.
 */

import { z } from "zod";

import {
  conversationWorkspaceCommandsEnabled,
  disableConversationWorkspaceCommands,
  upsertConversationToolGrant,
} from "../../approvals/conversation-tool-grant.js";
import { getConversation } from "../../persistence/conversation-crud.js";
import { resolveConversationId } from "../../persistence/conversation-key-store.js";
import {
  getBindingByChannelChat,
  listBindingsByExternalUser,
} from "../../persistence/external-conversation-store.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const workspaceCommandsResponseSchema = z.object({
  conversationId: z.string(),
  enabled: z.boolean(),
});

function resolveOrThrow(rawId: string): string {
  const id = resolveConversationId(rawId);
  if (!id) {
    throw new NotFoundError(`Conversation ${rawId} not found`);
  }
  return id;
}

function requireExistingConversation(conversationId: string): string {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    throw new NotFoundError(`Conversation ${conversationId} not found`);
  }
  return conversationId;
}

function resolveSlackConversation(params: {
  slackChannelId?: string;
  slackUserId?: string;
}): string {
  const slackChannelId = params.slackChannelId?.trim();
  const slackUserId = params.slackUserId?.trim();
  if (slackChannelId && slackUserId) {
    throw new BadRequestError(
      "Provide either slackChannelId or slackUserId, not both.",
    );
  }
  if (slackChannelId) {
    const binding = getBindingByChannelChat("slack", slackChannelId);
    if (!binding) {
      throw new NotFoundError(
        `No Slack conversation is bound to channel ${slackChannelId}.`,
      );
    }
    return binding.conversationId;
  }
  if (slackUserId) {
    const bindings = listBindingsByExternalUser("slack", slackUserId);
    if (bindings.length === 0) {
      throw new NotFoundError(
        `No Slack conversation is bound to user ${slackUserId}.`,
      );
    }
    if (bindings.length === 1) {
      return bindings[0]!.conversationId;
    }
    const dms = bindings.filter((binding) =>
      binding.externalChatId.startsWith("D"),
    );
    if (dms.length === 1) {
      return dms[0]!.conversationId;
    }
    const candidates = bindings
      .map((binding) => binding.conversationId)
      .join(", ");
    throw new BadRequestError(
      `Multiple Slack conversations match this user. Pass a conversation ID from assistant conversations list. Candidates: ${candidates}`,
    );
  }
  throw new BadRequestError("Missing conversation identifier.");
}

function resolveCliConversation(body: Record<string, unknown>): string {
  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId.trim() : "";
  const slackChannelId =
    typeof body.slackChannelId === "string" ? body.slackChannelId.trim() : "";
  const slackUserId =
    typeof body.slackUserId === "string" ? body.slackUserId.trim() : "";
  const provided = [conversationId, slackChannelId, slackUserId].filter(
    Boolean,
  );
  if (provided.length !== 1) {
    throw new BadRequestError(
      "Provide exactly one of conversationId, slackChannelId, or slackUserId.",
    );
  }
  if (conversationId) {
    return requireExistingConversation(resolveOrThrow(conversationId));
  }
  return requireExistingConversation(
    resolveSlackConversation({ slackChannelId, slackUserId }),
  );
}

function readWorkspaceCommands(conversationId: string): {
  conversationId: string;
  enabled: boolean;
} {
  return {
    conversationId,
    enabled: conversationWorkspaceCommandsEnabled(conversationId),
  };
}

function writeWorkspaceCommands(
  conversationId: string,
  enabled: boolean,
  requestChannel: string,
): {
  conversationId: string;
  enabled: boolean;
} {
  if (enabled) {
    upsertConversationToolGrant({
      conversationId,
      requestChannel,
      decisionChannel: requestChannel,
      requesterExternalUserId: null,
    });
  } else {
    disableConversationWorkspaceCommands(conversationId);
  }
  return readWorkspaceCommands(conversationId);
}

function handleGetWorkspaceCommands({ pathParams = {} }: RouteHandlerArgs) {
  const conversationId = requireExistingConversation(
    resolveOrThrow(pathParams.id!),
  );
  return readWorkspaceCommands(conversationId);
}

function handleSetWorkspaceCommands({
  pathParams = {},
  body = {},
}: RouteHandlerArgs) {
  if (typeof body.enabled !== "boolean") {
    throw new BadRequestError("enabled must be a boolean");
  }
  const conversationId = requireExistingConversation(
    resolveOrThrow(pathParams.id!),
  );
  return writeWorkspaceCommands(conversationId, body.enabled, "http");
}

function handleGetWorkspaceCommandsCli({ body = {} }: RouteHandlerArgs) {
  return readWorkspaceCommands(resolveCliConversation(body));
}

function handleSetWorkspaceCommandsCli({ body = {} }: RouteHandlerArgs) {
  if (typeof body.enabled !== "boolean") {
    throw new BadRequestError("enabled must be a boolean");
  }
  return writeWorkspaceCommands(
    resolveCliConversation(body),
    body.enabled,
    "cli",
  );
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getConversationWorkspaceCommands",
    endpoint: "conversations/:id/workspace-commands",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    pathParams: [{ name: "id", type: "string" }],
    summary: "Get workspace commands for contacts",
    description:
      "Whether trusted contacts may run workspace shell commands in this conversation without a per-command approval.",
    tags: ["conversations"],
    responseBody: workspaceCommandsResponseSchema,
    handler: handleGetWorkspaceCommands,
  },
  {
    operationId: "setConversationWorkspaceCommands",
    endpoint: "conversations/:id/workspace-commands",
    method: "PUT",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    pathParams: [{ name: "id", type: "string" }],
    summary: "Set workspace commands for contacts",
    description:
      "Enable or disable standing workspace shell access for trusted contacts in this conversation. High-risk commands still require approval.",
    tags: ["conversations"],
    requestBody: z.object({
      enabled: z.boolean(),
    }),
    responseBody: workspaceCommandsResponseSchema,
    handler: handleSetWorkspaceCommands,
  },
  {
    operationId: "conversation_workspace_commands_get_cli",
    endpoint: "conversations/cli/workspace-commands/get",
    method: "POST",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Get workspace commands for contacts (CLI)",
    description:
      "Look up standing workspace-command access by conversation ID, Slack channel, or Slack user.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string().optional(),
      slackChannelId: z.string().optional(),
      slackUserId: z.string().optional(),
    }),
    responseBody: workspaceCommandsResponseSchema,
    handler: handleGetWorkspaceCommandsCli,
  },
  {
    operationId: "conversation_workspace_commands_set_cli",
    endpoint: "conversations/cli/workspace-commands/set",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Set workspace commands for contacts (CLI)",
    description:
      "Enable or disable standing workspace-command access by conversation ID, Slack channel, or Slack user.",
    tags: ["conversations"],
    requestBody: z.object({
      conversationId: z.string().optional(),
      slackChannelId: z.string().optional(),
      slackUserId: z.string().optional(),
      enabled: z.boolean(),
    }),
    responseBody: workspaceCommandsResponseSchema,
    handler: handleSetWorkspaceCommandsCli,
  },
];
