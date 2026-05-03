/**
 * In-memory tracker that maps requestId to conversation info for pending
 * confirmation, secret, host_bash, host_file, host_cu, host_browser, and
 * host_transfer interactions.
 *
 * For confirmation_request and secret_request, the onEvent callback in
 * assistant-event-hub registers the interaction here.
 *
 * For host proxy interactions (host_bash, host_file, host_cu, host_browser,
 * host_transfer), the proxy itself registers with full RPC lifecycle state
 * (resolve/reject callbacks, timer, abort detach). This eliminates the
 * per-proxy `private pending` maps — all pending state lives here.
 *
 * Standalone HTTP endpoints (/v1/confirm, /v1/secret, /v1/trust-rules,
 * /v1/host-bash-result, /v1/host-file-result, /v1/host-cu-result,
 * /v1/host-browser-result) look up the conversation from this tracker to
 * resolve the interaction.
 */

import type { UserDecision } from "../permissions/types.js";
import type { ToolExecutionResult } from "../tools/types.js";

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
  conversationId: string;
  kind:
    | "confirmation"
    | "secret"
    | "host_bash"
    | "host_file"
    | "host_cu"
    | "host_browser"
    | "host_app_control"
    | "host_transfer"
    | "acp_confirmation";
  confirmationDetails?: ConfirmationDetails;
  /** For ACP permissions: resolves directly without a Conversation object. */
  directResolve?: (decision: UserDecision) => void;
  /** When set, the host_bash request should be routed to this specific client. */
  targetClientId?: string;

  // -- RPC lifecycle (populated by host proxies) --

  /** Resolve the caller's Promise with a tool execution result. */
  rpcResolve?: (result: ToolExecutionResult) => void;
  /** Reject the caller's Promise with an error. */
  rpcReject?: (err: Error) => void;
  /** Proxy-side timeout timer. Cleared on resolve/abort/dispose. */
  timer?: ReturnType<typeof setTimeout>;
  /** Detach the abort listener from the caller's signal. No-op when no signal was passed. */
  detachAbort?: () => void;
  /** Proxy-specific metadata (e.g. timeoutSec for bash, operation/path for file). */
  metadata?: Record<string, unknown>;
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
 * Auto-clears the proxy timer and detaches the abort listener if present.
 * Returns undefined if no interaction is registered.
 */
export function resolve(requestId: string): PendingInteraction | undefined {
  const interaction = pending.get(requestId);
  if (interaction) {
    pending.delete(requestId);
    if (interaction.timer != null) clearTimeout(interaction.timer);
    interaction.detachAbort?.();
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
 * host_bash, host_file, host_cu, host_browser, host_app_control, and
 * host_transfer interactions are intentionally skipped — they represent
 * in-flight tool executions proxied to the client, not confirmations to
 * auto-deny. Removing them would orphan the request: the client would POST to
 * /v1/host-bash-result, /v1/host-file-result, /v1/host-cu-result,
 * /v1/host-browser-result, /v1/host-app-control-result, or
 * /v1/host-transfer-result after completing the operation, get a 404, and the
 * proxy timer would fire with a spurious timeout error.
 */
export function removeByConversation(conversationId: string): void {
  for (const [requestId, interaction] of pending) {
    if (
      interaction.conversationId === conversationId &&
      interaction.kind !== "host_bash" &&
      interaction.kind !== "host_file" &&
      interaction.kind !== "host_cu" &&
      interaction.kind !== "host_browser" &&
      interaction.kind !== "host_app_control" &&
      interaction.kind !== "host_transfer" &&
      interaction.kind !== "acp_confirmation"
    ) {
      pending.delete(requestId);
    }
  }
}

/**
 * Return all pending interactions of a given kind.
 */
export function getByKind(
  kind: PendingInteraction["kind"],
): Array<{ requestId: string } & PendingInteraction> {
  const results: Array<{ requestId: string } & PendingInteraction> = [];
  for (const [requestId, interaction] of pending) {
    if (interaction.kind === kind) {
      results.push({ requestId, ...interaction });
    }
  }
  return results;
}

/**
 * Return all pending interactions across all conversations.
 */
export function getAll(): Array<{ requestId: string } & PendingInteraction> {
  const results: Array<{ requestId: string } & PendingInteraction> = [];
  for (const [requestId, interaction] of pending) {
    results.push({ requestId, ...interaction });
  }
  return results;
}

/** Clear all pending interactions. Useful for testing. */
export function clear(): void {
  pending.clear();
}
