import type { DrizzleDb } from "../../../persistence/db-connection.js";
import type { TrustClass } from "../../../runtime/actor-trust-resolver.js";
import { memoryPersistenceHooks } from "./persistence-hooks.js";

/**
 * The memory plugin's persistence-lifecycle seam: the hook contract and the
 * registered-handler slot.
 *
 * Persistence is a layer below the memory plugin, so it cannot import memory
 * internals directly. Instead it calls into this registered-handler seam:
 * `registerMemoryPersistenceHooks` installs the plugin's implementation at
 * bootstrap, and persistence invokes the current implementation
 * (`getMemoryPersistenceHooks`) at the relevant call sites.
 * When no implementation is registered — memory absent, disabled before
 * bootstrap, or a unit test that skips plugin bootstrap — the calls fall
 * through to a no-op, which is the correct "memory is not present" behaviour.
 *
 * The seam is a memory-plugin-only concept, owned by the plugin rather than
 * the persistence layer: every event and query on it is memory-domain. The
 * persistence call sites that invoke `getMemoryPersistenceHooks()` are
 * documented back-imports in the persistence-layering guard, to be unwound by
 * exposing the lifecycle events through the first-class `hooks` system.
 *
 * Importing the implementation here puts this module on an import cycle
 * (persistence imports the seam; the implementation transitively imports
 * persistence). The cycle is benign: every binding on it is read at call
 * time — the persistence call sites invoke `getMemoryPersistenceHooks()`
 * inside functions, and `registerMemoryPersistenceHooks` reads the
 * implementation binding when bootstrap calls it — so no module body ever
 * observes a half-initialized module.
 *
 * The seam is a single registered handler (not a multi-subscriber event bus)
 * because the persistence call sites run synchronously inside their write paths
 * and there is exactly one subscriber (the memory plugin). Handler methods are
 * registered as a unit, mirroring how plugins contribute injectors and
 * job-handlers up-front at bootstrap.
 *
 * Payload types reference only persistence/host primitives so no memory type
 * leaks into the persistence layer.
 */

/** A message that was just persisted to a conversation. */
export interface MessagePersistedEvent {
  messageId: string;
  conversationId: string;
  role: string;
  /** Stored message content (JSON content-block array, serialized). */
  content: string;
  createdAt: number;
  /** Trust class of the actor who produced the message, captured at persist time. */
  provenanceTrustClass?: TrustClass;
  /** True when the message was auto-sent by the client (e.g. a wake-up greeting). */
  automated?: boolean;
}

/** A conversation was forked; the memory feature carries per-conversation state into the child. */
export interface ConversationForkedEvent {
  db: DrizzleDb;
  sourceConversationId: string;
  forkId: string;
  /**
   * Full-history fork (the child contains every source message). When false the
   * fork is truncated and per-conversation memory state is re-derived from the
   * child's visible window instead of copied wholesale.
   */
  isFullHistoryFork: boolean;
  /** The copied messages, in order. Only `id` and `metadata` are read. */
  messagesToCopy: ReadonlyArray<{ id: string; metadata: string | null }>;
  /** Map of source message id → forked message id. */
  forkedMessageIds: Map<string, string>;
  /** Count of inherited messages behind the fork's compaction boundary. */
  inheritedCompactedMessageCount: number;
}

/** Handlers the memory feature registers to observe persistence lifecycle events. */
export interface MemoryPersistenceHooks {
  /**
   * A message was persisted (and not deduplicated). The memory feature indexes
   * it. Awaited inside the write path; the caller wraps the call in try/catch
   * and logs failures without failing the write, so a throwing implementation
   * is tolerated.
   */
  onMessagePersisted(event: MessagePersistedEvent): Promise<void> | void;

  /**
   * A conversation was forked. The memory feature carries the parent's
   * per-conversation memory state (activation/injection logs, graph state,
   * retrospective state) into the child. Runs synchronously inside the fork's
   * transaction with the live `db` handle.
   */
  onConversationForked(event: ConversationForkedEvent): void;

  /**
   * A conversation is being wiped. The memory feature cancels its pending jobs
   * for that conversation; returns the number cancelled (0 when memory is not
   * present). Runs before the conversation's message rows are deleted, since
   * the cancellation queries join on `messages`. Cleanup — runs even while the
   * plugin is disabled, so jobs created while it was enabled are not orphaned.
   *
   * Does NOT purge the conversation's per-message index — that is
   * {@link onConversationDeleted}, fired from the shared delete primitive that
   * `wipeConversation` delegates to (so the purge lands after this cancellation
   * pass and cannot be swept by it).
   */
  onConversationWiped(conversationId: string): number;

  /**
   * A conversation and its messages were deleted via the shared delete
   * primitive (`deleteConversation`/`deleteConversationGently`), which covers
   * every caller — the HTTP route, `wipeConversation`, retrospective startup
   * cleanup, superseded-retrospective GC, and future ones. The memory feature
   * purges the conversation's per-message index (e.g. its lexical points, by
   * `conversationId`). Runs after the delete commits and off the write path.
   * Cleanup — runs even while the plugin is disabled, so points written while it
   * was enabled are not orphaned.
   */
  onConversationDeleted(conversationId: string): void;

  /**
   * One or more message rows were deleted (single-message delete, undo, or
   * assistant-message consolidation) WITHOUT wiping the whole conversation. The
   * memory feature removes each message's per-message index entry (e.g. its
   * lexical point). Runs after the delete transaction commits and off the write
   * path. Cleanup — runs even while the plugin is disabled, so entries written
   * while it was enabled are not orphaned. Empty arrays are a no-op.
   */
  onMessagesDeleted(messageIds: string[]): void;

  /**
   * Every conversation and its messages are being cleared ("delete all"). The
   * memory feature drops the bulk per-message index (e.g. the whole lexical
   * collection) — a bulk wipe leaves no ids to key per-message cleanup on.
   * Cleanup — runs even while the plugin is disabled. Best-effort; the caller
   * wraps it in try/catch and AWAITS it, so the drop completes before writes
   * resume (a message created right after clear-all must not upsert into a
   * collection that is about to be dropped).
   */
  onAllConversationsCleared(): Promise<void>;
}

const NOOP: MemoryPersistenceHooks = {
  onMessagePersisted() {},
  onConversationForked() {},
  onConversationWiped() {
    return 0;
  },
  onConversationDeleted() {},
  onMessagesDeleted() {},
  async onAllConversationsCleared() {},
};

let current: MemoryPersistenceHooks = NOOP;

/**
 * Install the memory feature's persistence-lifecycle handlers.
 * `bootstrapPlugins` calls this before the per-plugin init loop so the seam
 * is wired up front; the standalone memory jobs worker, which has no plugin
 * bootstrap, calls it directly. Idempotent: replaces any prior registration.
 */
export function registerMemoryPersistenceHooks(): void {
  current = memoryPersistenceHooks;
}

/** The currently-registered handlers, or a no-op set when memory is not present. */
export function getMemoryPersistenceHooks(): MemoryPersistenceHooks {
  return current;
}

/** Test-only: restore the no-op default so a test starts from a clean seam. */
export function resetMemoryPersistenceHooksForTests(): void {
  current = NOOP;
}

/** Test-only: install a spy/stub handler set in place of the real implementation. */
export function setMemoryPersistenceHooksForTests(
  hooks: MemoryPersistenceHooks,
): void {
  current = hooks;
}
