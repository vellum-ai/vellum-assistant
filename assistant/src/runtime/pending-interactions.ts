/**
 * In-memory tracker that maps requestId to conversation info for pending
 * confirmation, secret, host_bash, host_file, host_cu, and host_browser
 * interactions.
 *
 * When the agent loop emits a confirmation_request, secret_request,
 * host_bash_request, host_file_request, host_cu_request, or
 * host_browser_request, the onEvent callback registers the interaction here.
 * Standalone HTTP endpoints (/v1/confirm, /v1/secret, /v1/trust-rules,
 * /v1/host-bash-result, /v1/host-file-result, /v1/host-cu-result,
 * /v1/host-browser-result) look up the conversation from this tracker to
 * resolve the interaction.
 */

import type { Conversation } from "../daemon/conversation.js";
import type { UserDecision } from "../permissions/types.js";

export interface ConfirmationDetails {
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: string;
  executionTarget?: "sandbox" | "host";
  allowlistOptions: Array<{
    label: string;
    description: string;
    pattern: string;
  }>;
  scopeOptions: Array<{ label: string; scope: string }>;
  persistentDecisionsAllowed?: boolean;
  temporaryOptionsAvailable?: Array<"allow_10m" | "allow_conversation">;
  /** ACP tool kind from the agent (e.g. "read", "edit", "execute"). */
  acpToolKind?: string;
  /** ACP permission options from the agent. */
  acpOptions?: Array<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
}

export interface PendingInteraction {
  conversation: Conversation | null;
  conversationId: string;
  kind:
    | "confirmation"
    | "secret"
    | "host_bash"
    | "host_file"
    | "host_cu"
    | "host_browser"
    | "acp_confirmation";
  confirmationDetails?: ConfirmationDetails;
  /** For ACP permissions: resolves directly without a Conversation object. */
  directResolve?: (decision: UserDecision) => void;
  /**
   * For host_browser interactions originating outside an agent loop
   * (e.g. the `assistant browser chrome relay` CLI shim that POSTs to
   * /v1/browser-cdp). Resolves the CDP round-trip directly without
   * touching a Conversation. When set, /v1/host-browser-result invokes
   * this instead of `interaction.conversation.resolveHostBrowser`.
   */
  directBrowserResolve?: (response: {
    content: string;
    isError: boolean;
  }) => void;
}

const pending = new Map<string, PendingInteraction>();

export function register(
  requestId: string,
  interaction: PendingInteraction,
): void {
  pending.set(requestId, interaction);
}

/**
 * Remove and return the pending interaction for the given requestId.
 * Returns undefined if no interaction is registered.
 */
export function resolve(requestId: string): PendingInteraction | undefined {
  const interaction = pending.get(requestId);
  if (interaction) {
    pending.delete(requestId);
  }
  return interaction;
}

/**
 * Return the pending interaction without removing it.
 * Used by trust-rule endpoint which doesn't resolve the confirmation itself.
 */
export function get(requestId: string): PendingInteraction | undefined {
  return pending.get(requestId);
}

/**
 * Return all pending interactions for a given conversation.
 * Needed by channel approval migration.
 */
export function getByConversation(
  conversationId: string,
): Array<{ requestId: string } & PendingInteraction> {
  const results: Array<{ requestId: string } & PendingInteraction> = [];
  for (const [requestId, interaction] of pending) {
    if (interaction.conversationId === conversationId) {
      results.push({ requestId, ...interaction });
    }
  }
  return results;
}

/**
 * Remove pending confirmation and secret interactions for a given conversation.
 * Used when auto-denying all pending interactions (e.g. new user message).
 *
 * host_bash, host_file, host_cu, and host_browser interactions are
 * intentionally skipped — they represent in-flight tool executions proxied to
 * the client, not confirmations to auto-deny. Removing them would orphan the
 * request: the client would POST to /v1/host-bash-result,
 * /v1/host-file-result, /v1/host-cu-result, or /v1/host-browser-result after
 * completing the operation, get a 404, and the proxy timer would fire with a
 * spurious timeout error.
 */
export function removeByConversation(conversation: Conversation): void {
  for (const [requestId, interaction] of pending) {
    if (
      interaction.conversation === conversation &&
      interaction.kind !== "host_bash" &&
      interaction.kind !== "host_file" &&
      interaction.kind !== "host_cu" &&
      interaction.kind !== "host_browser" &&
      interaction.kind !== "acp_confirmation"
    ) {
      pending.delete(requestId);
    }
  }
}

/** Clear all pending interactions. Useful for testing. */
export function clear(): void {
  pending.clear();
}
