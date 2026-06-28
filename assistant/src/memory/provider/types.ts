/**
 * Internal `MemoryProvider` contract.
 *
 * Captures the full surface memory exposes to daemon core: per-turn and
 * per-context injection, post-turn write/consolidation enqueue, the tools and
 * routes the active memory system contributes, and lifecycle setup/teardown.
 * The graph (v1), v2 (concept-page), and v3 (shadow) systems each become a
 * single interchangeable implementation of this interface, selected by
 * `memory.provider`.
 */

import type { MemoryConfig } from "../../config/schemas/memory.js";
import type { TrustContext } from "../../daemon/trust-context.js";
import type { InjectionBlock } from "../../plugins/types.js";
import type { Message } from "../../providers/types.js";
import type { RouteDefinition } from "../../runtime/routes/types.js";
import type { ToolDefinition } from "../../tools/types.js";

/**
 * Stable identifier for a memory system. `"none"` disables memory entirely
 * (no injection, no memory tools).
 */
export type MemoryProviderId = "graph" | "v2" | "v3" | "none";

/**
 * Inputs a provider needs to produce injection or enqueue post-turn work.
 *
 * Carries the turn identifiers, the working message array for the turn, a
 * read-only slice of memory configuration, and the per-turn position and trust
 * classification the v3 injectors require. Providers scope their behaviour off
 * this context without reaching for global config.
 */
export interface MemoryProviderContext {
  /** Conversation the turn is scoped to. */
  readonly conversationId: string;
  /** Stable per-request id (one per inbound message), for log correlation. */
  readonly requestId: string;
  /** The turn's working message array. */
  readonly messages: Message[];
  /** Read-only memory configuration slice. */
  readonly config: MemoryConfig;
  /**
   * 0-based turn index within the conversation — the v3 orchestration memo key
   * and shadow-turn `turnNumber`.
   */
  readonly turnIndex: number;
  /** Trust classification and channel identity for the inbound actor. */
  readonly trust: TrustContext;
}

/**
 * The full surface a memory system exposes to daemon core.
 *
 * Implementations adapt the existing graph/v2/v3 systems; daemon core selects
 * one by `id` via `memory.provider` and drives it through this interface.
 */
export interface MemoryProvider {
  /** Which memory system this provider implements. */
  readonly id: MemoryProviderId;

  /**
   * Produce the context-load injection blocks (the memory prefix grafted onto
   * the turn before the user's content). Returns an empty array when this
   * provider contributes nothing for the given context.
   */
  retrieveForContext(ctx: MemoryProviderContext): Promise<InjectionBlock[]>;

  /**
   * Produce the per-turn injection blocks (e.g. activation/selection results
   * resolved against the current turn). Returns an empty array when this
   * provider contributes nothing on this turn.
   */
  retrieveForTurn(ctx: MemoryProviderContext): Promise<InjectionBlock[]>;

  /**
   * Post-turn seam fired after the turn is persisted. Enqueues writes and
   * consolidation work; must not run LLM work synchronously (enqueue only).
   */
  onTurnCommit(ctx: MemoryProviderContext): Promise<void>;

  /** The model-visible tool definitions this provider contributes. */
  provideTools(): ToolDefinition[];

  /**
   * Optional maintenance route definitions this provider contributes. Omitted
   * by providers that own no routes.
   */
  provideRoutes?(): RouteDefinition[];

  /** Lifecycle setup, run once before the provider is used. */
  init(): Promise<void>;

  /** Lifecycle teardown, run once when the provider is retired. */
  shutdown(): Promise<void>;
}
