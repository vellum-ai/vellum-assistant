/**
 * Per-conversation {@link ContextWindowManager} ownership for the default
 * compaction module.
 *
 * Construction of the manager lives here rather than in the conversation so the
 * compaction surface owns the manager's lifetime: {@link createContextWindowManager}
 * builds the instance and records it in a per-conversation store, and
 * {@link disposeContextWindowManager} drops it when the conversation is torn
 * down so the store doesn't grow unbounded.
 *
 * This module is side-effect free: importing it only initializes an empty
 * store and registers no plugin.
 */

import {
  ContextWindowManager,
  type ContextWindowManagerOptions,
} from "./window-manager.js";

/** Live managers keyed by conversation id. */
const managersByConversation = new Map<string, ContextWindowManager>();

/**
 * Build the conversation's {@link ContextWindowManager} and register it under
 * its conversation id. Construction is owned by the compaction module; the
 * conversation supplies the provider, prompt/tool resolvers, and initial
 * config. Replaces any prior manager for the same conversation so each
 * construction yields a fresh instance, matching a direct `new` call.
 */
export function createContextWindowManager(
  options: ContextWindowManagerOptions & { conversationId: string },
): ContextWindowManager {
  const manager = new ContextWindowManager(options);
  managersByConversation.set(options.conversationId, manager);
  return manager;
}

/**
 * Resolve the manager registered for a conversation, or `undefined` when none
 * is registered (the conversation was never constructed or has been torn
 * down). The store is the single owner of the instance; the conversation, its
 * agent loop, and the compaction surface all read through this lookup rather
 * than holding their own handle.
 */
export function getContextWindowManager(
  conversationId: string,
): ContextWindowManager | undefined {
  return managersByConversation.get(conversationId);
}

/**
 * Release the manager registered for a conversation. Called from conversation
 * teardown so the store releases the instance once the conversation is gone.
 */
export function disposeContextWindowManager(conversationId: string): void {
  managersByConversation.delete(conversationId);
}
