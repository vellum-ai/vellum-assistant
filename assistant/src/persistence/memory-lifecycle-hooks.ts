import type { TrustClass } from "../runtime/actor-trust-resolver.js";

/**
 * Seam for the memory feature to react to persistence-layer lifecycle events.
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

/** Handlers the memory feature registers to observe persistence lifecycle events. */
export interface MemoryPersistenceHooks {
  /**
   * A message was persisted (and not deduplicated). The memory feature indexes
   * it. Awaited inside the write path; the caller wraps the call in try/catch
   * and logs failures without failing the write, so a throwing implementation
   * is tolerated.
   */
  onMessagePersisted(event: MessagePersistedEvent): Promise<void> | void;
}

const NOOP: MemoryPersistenceHooks = {
  onMessagePersisted() {},
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
