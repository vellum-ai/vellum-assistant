/**
 * In-memory tracker that maps requestId to conversation info for pending
 * confirmation, secret, host_bash, host_file, host_cu, host_browser, and
 * host_transfer interactions.
 *
 * All request types self-register with their full RPC lifecycle state
 * (resolve/reject callbacks, timer, abort detach):
 *
 * - Host proxies (host_bash, host_file, host_cu, host_browser,
 *   host_app_control, host_transfer): register in request(), using
 *   rpcResolve/rpcReject/timer/detachAbort/metadata.
 *
 * - Prompters (PermissionPrompter, SecretPrompter): register in prompt(),
 *   using promptResolve/promptReject/timer/toolUseId.
 *
 * Standalone HTTP endpoints (/v1/confirm, /v1/secret, /v1/trust-rules,
 * /v1/host-bash-result, etc.) look up the conversation from this tracker to
 * resolve the interaction.
 */

import type { InteractionResolutionState } from "../api/events/interaction-resolved.js";
import type { UserDecision } from "../permissions/types.js";
import { getLogger } from "../util/logger.js";
import { broadcastMessage } from "./assistant-event-hub.js";

const log = getLogger("pending-interactions");

export type { InteractionResolutionState } from "../api/events/interaction-resolved.js";

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
  directoryScopeOptions?: Array<{ label: string; scope: string }>;
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
  /**
   * Owning conversation, when the interaction was raised inside one. Absent
   * for interactions raised outside any conversation (e.g. the CLI
   * `credentials prompt` command), which resolve via {@link rpcResolve}.
   */
  conversationId?: string;
  kind:
    | "confirmation"
    | "secret"
    | "question"
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
  /**
   * Snapshot of `targetClientId`'s `actorPrincipalId` taken at registration
   * time. Persisted so the result-route same-actor check compares against
   * a stable value rather than the live hub — the target client's SSE
   * subscription may have briefly disconnected between dispatch and result
   * submission, which would otherwise 403 a legitimate result.
   */
  targetActorPrincipalId?: string;

  // -- RPC lifecycle (all interaction types) --

  /** Resolve the caller's Promise. Typed as unknown; callers cast at use sites. */
  rpcResolve?: (value: unknown) => void;
  /** Reject the caller's Promise with an error. */
  rpcReject?: (err: Error) => void;
  /** Timeout timer. Cleared automatically on resolve(). */
  timer?: ReturnType<typeof setTimeout>;
  /** Detach the abort listener from the caller's signal. No-op when no signal was passed. */
  detachAbort?: () => void;
  /** Proxy-specific metadata (e.g. timeoutSec for bash, operation/path for file). */
  metadata?: Record<string, unknown>;
  /** toolUseId associated with a confirmation_request (PermissionPrompter). */
  toolUseId?: string;
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
 *
 * Emits `interaction_resolved` on the event hub when an interaction is
 * actually removed (no-op when the entry was already consumed by another
 * path). Callers pass `state` to communicate the lifecycle outcome
 * — defaults to `"cancelled"`, the safest value when the call site has
 * no extra context.
 */
export function resolve(
  requestId: string,
  state: InteractionResolutionState = "cancelled",
): PendingInteraction | undefined {
  const interaction = pending.get(requestId);
  if (!interaction) return undefined;
  pending.delete(requestId);
  if (interaction.timer != null) clearTimeout(interaction.timer);
  interaction.detachAbort?.();
  emitResolved(requestId, interaction, state);
  return interaction;
}

function emitResolved(
  requestId: string,
  interaction: PendingInteraction,
  state: InteractionResolutionState,
): void {
  log.info(
    {
      requestId,
      conversationId: interaction.conversationId,
      kind: interaction.kind,
      state,
    },
    "Pending interaction resolved",
  );
  // interaction_resolved is conversation-scoped on the wire; a conversation-less
  // interaction has no conversation for clients to route the event to, so skip
  // the broadcast.
  if (interaction.conversationId === undefined) return;
  broadcastMessage({
    type: "interaction_resolved",
    requestId,
    conversationId: interaction.conversationId,
    kind: interaction.kind,
    state,
  });
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
export function removeByConversation(
  conversationId: string,
  state: InteractionResolutionState = "superseded",
): void {
  // Snapshot keys to avoid mutation-during-iteration.
  for (const [requestId, interaction] of [...pending]) {
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
      // resolve() clears the stored timer and detaches abort listeners.
      resolve(requestId, state);
      // Secret prompts have no abort-signal teardown (unlike questions) and
      // are not pre-settled by denyAllPendingConfirmations (unlike
      // confirmations), so removing the entry alone would leave the caller's
      // Promise — the CLI `credentials prompt` command or the in-conversation
      // SecretPrompter — hanging until its IPC client times out. Settle it
      // with a cancelled result, matching the prompt timeout path. rpcResolve
      // is idempotent, so any later resolveSecret/dispose call is a no-op.
      if (interaction.kind === "secret") {
        interaction.rpcResolve?.({ value: null, delivery: "store" });
      }
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
