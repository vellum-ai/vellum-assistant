/**
 * SSE event type definitions for the assistant event stream.
 *
 * Contains all SSE event interfaces, the discriminated `AssistantEvent` union,
 * and supporting types consumed by the event bus, event parser, and stream
 * handler modules. These are cross-domain shared types — the event bus store
 * and multiple domains subscribe to these events.
 *
 * Every wire event is covered by `APIAssistantEvent` (the inferred union
 * from `@vellumai/assistant-api`); each new schema added there appears in
 * `AssistantEvent` automatically. `UnknownEvent` is the client-only
 * fallback the parser emits for any payload the canonical union doesn't
 * recognise.
 */

import type { AssistantEvent as APIAssistantEvent } from "@vellumai/assistant-api";

// ---------------------------------------------------------------------------
// SSE event interfaces
// ---------------------------------------------------------------------------

/** Valid decisions accepted by the assistant runtime's POST /v1/confirm endpoint. */
export type ConfirmationDecision = "allow" | "deny";

export interface UnknownEvent {
  type: "unknown";
  rawType: string;
  data: Record<string, unknown>;
  conversationId?: string;
}

/**
 * Mirrors the daemon's `PendingInteraction["kind"]` union
 * (`assistant/src/runtime/pending-interactions.ts`). Split into user-facing
 * kinds (prompts that block the conversation waiting for a person) and
 * host-proxy kinds (intermediate tool steps that resolve mid-turn).
 *
 * Keep in sync with the daemon enum — adding a kind on one side without the
 * other causes the attention-tracking allowlist to silently miss or
 * incorrectly clear processing indicators.
 */
export type UserFacingInteractionKind =
  | "confirmation"
  | "secret"
  | "question"
  | "acp_confirmation";

export type HostProxyInteractionKind =
  | "host_bash"
  | "host_file"
  | "host_cu"
  | "host_browser"
  | "host_app_control"
  | "host_transfer";

export type InteractionKind =
  | UserFacingInteractionKind
  | HostProxyInteractionKind;

/**
 * Allowlist of interaction kinds that signal the daemon has handed control
 * back to a person (vs intermediate host-proxy tool steps). Attention
 * tracking uses this to decide whether to clear processing/attention state
 * on `interaction_resolved`.
 */
export const USER_FACING_INTERACTION_KINDS: ReadonlySet<string> =
  new Set<UserFacingInteractionKind>([
    "confirmation",
    "secret",
    "question",
    "acp_confirmation",
  ]);

// ---------------------------------------------------------------------------
// AssistantEvent union
// ---------------------------------------------------------------------------

/**
 * Every event the chat SSE stream might emit. All wire events are
 * covered by `APIAssistantEvent` (the inferred union from
 * `@vellumai/assistant-api`); each new schema added there appears here
 * automatically. `UnknownEvent` is the client-only fallback for any
 * payload the canonical union doesn't recognise.
 */
export type AssistantEvent = APIAssistantEvent | UnknownEvent;
