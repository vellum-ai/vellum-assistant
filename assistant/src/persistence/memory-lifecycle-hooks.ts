import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import type { DrizzleDb } from "./db-connection.js";

/**
 * Seam for the memory feature to react to persistence-layer lifecycle events
 * and to answer memory-domain queries the persistence layer needs.
 *
 * Persistence is a layer below the memory plugin, so it cannot import memory
 * internals directly. Instead it calls into this registered-handler seam: the
 * memory plugin installs an implementation at bootstrap
 * (`registerMemoryPersistenceHooks`), and persistence invokes the current
 * implementation (`getMemoryPersistenceHooks`) at the relevant call sites. When
 * no implementation is registered — memory absent, disabled before bootstrap,
 * or a unit test that skips plugin bootstrap — the calls fall through to a
 * no-op, which is the correct "memory is not present" behaviour.
 *
 * The seam is a single registered handler (not a multi-subscriber event bus)
 * because the persistence call sites run synchronously inside their write paths
 * and there is exactly one subscriber (the memory plugin). Handler methods are
 * registered as a unit, mirroring how plugins contribute injectors and
 * job-handlers up-front at bootstrap.
 *
 * Payload types reference only persistence/host primitives so no memory type
 * leaks into this layer.
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
   */
  onConversationWiped(conversationId: string): number;

  /**
   * The background-job worker is starting. The memory feature sweeps orphan
   * retrospective conversations left by a crash mid-job. Best-effort; the caller
   * wraps it in try/catch. Cleanup — runs even while the plugin is disabled.
   */
  onWorkerStartup(): void;

  /**
   * Current line count of the memory buffer (`memory/buffer.md`). The
   * maintenance scheduler reads it to gate scheduled consolidation — skip a
   * scheduled run below a floor, force one above a ceiling. Returns 0 when
   * memory is not present, which the scheduler reads as "no buffered work" and
   * therefore no consolidation.
   */
  countMemoryBufferLines(): number;
}

const NOOP: MemoryPersistenceHooks = {
  onMessagePersisted() {},
  onConversationForked() {},
  onConversationWiped() {
    return 0;
  },
  onWorkerStartup() {},
  countMemoryBufferLines() {
    return 0;
  },
};

let current: MemoryPersistenceHooks = NOOP;

/** Install the memory feature's persistence-lifecycle handlers. Idempotent: replaces any prior registration. */
export function registerMemoryPersistenceHooks(
  hooks: MemoryPersistenceHooks,
): void {
  current = hooks;
}

/** The currently-registered handlers, or a no-op set when memory is not present. */
export function getMemoryPersistenceHooks(): MemoryPersistenceHooks {
  return current;
}

/** Test-only: restore the no-op default so a test starts from a clean seam. */
export function resetMemoryPersistenceHooksForTests(): void {
  current = NOOP;
}
