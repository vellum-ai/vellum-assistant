/**
 * In-memory tracker that maps requestId to session info for pending
 * confirmation, secret, host_bash, host_file, and host_cu interactions.
 *
 * When the agent loop emits a confirmation_request, secret_request,
 * host_bash_request, host_file_request, or host_cu_request, the onEvent
 * callback registers the interaction here. Standalone HTTP endpoints
 * (/v1/confirm, /v1/secret, /v1/trust-rules, /v1/host-bash-result,
 * /v1/host-file-result, /v1/host-cu-result) look up the session from
 * this tracker to resolve the interaction.
 */

import type { Session } from "../daemon/session.js";

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
  temporaryOptionsAvailable?: Array<"allow_10m" | "allow_thread">;
}

export interface PendingInteraction {
  session: Session;
  conversationId: string;
  kind: "confirmation" | "secret" | "host_bash" | "host_file" | "host_cu";
  confirmationDetails?: ConfirmationDetails;
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
 * Needed by channel approval migration (PR 3).
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
 * Remove pending confirmation and secret interactions for a given session.
 * Used when auto-denying all pending interactions (e.g. new user message).
 *
 * host_bash, host_file, and host_cu interactions are intentionally skipped
 * — they represent in-flight tool executions proxied to the client, not
 * confirmations to auto-deny. Removing them would orphan the request: the
 * client would POST to /v1/host-bash-result, /v1/host-file-result, or
 * /v1/host-cu-result after completing the operation, get a 404, and the
 * proxy timer would fire with a spurious timeout error.
 */
export function removeBySession(session: Session): void {
  for (const [requestId, interaction] of pending) {
    if (
      interaction.session === session &&
      interaction.kind !== "host_bash" &&
      interaction.kind !== "host_file" &&
      interaction.kind !== "host_cu"
    ) {
      pending.delete(requestId);
    }
  }
}

/** Clear all pending interactions. Useful for testing. */
export function clear(): void {
  pending.clear();
}
