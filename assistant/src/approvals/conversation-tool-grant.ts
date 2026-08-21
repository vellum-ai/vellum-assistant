/**
 * Standing conversation_tool grants for sandbox workspace commands.
 *
 * A grant authorizes trusted contacts to run sandbox `bash` in one
 * conversation without a per-command guardian card. High-risk bash still
 * escalates. host_bash is never covered.
 */

import { mintGrantFromDecision } from "./approval-primitive.js";
import {
  _internal,
  type ScopedApprovalGrant,
} from "./scoped-approval-grants.js";

const {
  findActiveConversationToolGrant,
  hasActiveConversationToolGrant,
  revokeConversationToolGrants,
} = _internal;

/** Sandbox tool covered by a conversation workspace-commands grant. */
export const CONVERSATION_WORKSPACE_COMMANDS_TOOL = "bash";

/**
 * Standing grants last until revoked. expireScopedApprovalGrants sweeps
 * any row whose expiresAt is in the past, so this must be far in the future.
 */
export const CONVERSATION_TOOL_GRANT_EXPIRES_AT = Date.parse(
  "2099-12-31T00:00:00.000Z",
);

export interface UpsertConversationToolGrantParams {
  conversationId: string;
  requestChannel: string;
  decisionChannel: string;
  requesterExternalUserId?: string | null;
  guardianExternalUserId?: string | null;
  toolName?: string;
}

export function upsertConversationToolGrant(
  params: UpsertConversationToolGrantParams,
): ScopedApprovalGrant {
  const toolName = params.toolName ?? CONVERSATION_WORKSPACE_COMMANDS_TOOL;
  const requesterExternalUserId = params.requesterExternalUserId ?? null;

  const existing = findActiveConversationToolGrant({
    toolName,
    conversationId: params.conversationId,
    requesterExternalUserId,
  });
  if (existing) {
    return existing;
  }

  const result = mintGrantFromDecision({
    scopeMode: "conversation_tool",
    toolName,
    requestChannel: params.requestChannel,
    decisionChannel: params.decisionChannel,
    conversationId: params.conversationId,
    requesterExternalUserId,
    guardianExternalUserId: params.guardianExternalUserId ?? null,
    expiresAt: CONVERSATION_TOOL_GRANT_EXPIRES_AT,
  });

  if (!result.ok) {
    throw new Error(`Failed to mint conversation_tool grant: ${result.reason}`);
  }

  return result.grant;
}

export function conversationWorkspaceCommandsEnabled(
  conversationId: string,
  toolName: string = CONVERSATION_WORKSPACE_COMMANDS_TOOL,
): boolean {
  return hasActiveConversationToolGrant({
    toolName,
    conversationId,
  });
}

export function disableConversationWorkspaceCommands(
  conversationId: string,
  toolName: string = CONVERSATION_WORKSPACE_COMMANDS_TOOL,
): number {
  return revokeConversationToolGrants(conversationId, toolName);
}
