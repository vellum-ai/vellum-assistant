/**
 * Per-conversation {@link ContextWindowManager} ownership for the default
 * compaction module.
 *
 * The compaction surface owns the manager's lifetime end to end. A conversation
 * registers a recipe for its manager via {@link registerContextWindowManager};
 * the manager itself is built lazily on first access (get-or-create) so the
 * compaction module — not the conversation — performs every construction.
 * {@link getContextWindowManager} resolves the live instance, building it from
 * the recipe the first time it is needed, and {@link disposeContextWindowManager}
 * drops both recipe and instance when the conversation is torn down so the
 * store doesn't grow unbounded.
 *
 * This module is side-effect free: importing it only initializes empty stores
 * and registers no plugin.
 */

import {
  ContextWindowManager,
  type ContextWindowManagerOptions,
} from "./window-manager.js";

/** Recipe producing the construction options for a conversation's manager. */
type ContextWindowManagerRecipe = () => ContextWindowManagerOptions & {
  conversationId: string;
};

/** Recipes keyed by conversation id; the source for lazy construction. */
const recipesByConversation = new Map<string, ContextWindowManagerRecipe>();

/** Live managers keyed by conversation id, built on first access. */
const managersByConversation = new Map<string, ContextWindowManager>();

/**
 * Register how a conversation's {@link ContextWindowManager} is built without
 * constructing it yet. The conversation supplies the provider, prompt/tool
 * resolvers, and initial config through the recipe; construction is deferred to
 * the first {@link getContextWindowManager} call so the compaction module owns
 * every `new ContextWindowManager`. Replaces any prior recipe and drops a
 * previously built instance so the next access rebuilds from the new recipe.
 */
export function registerContextWindowManager(
  conversationId: string,
  recipe: ContextWindowManagerRecipe,
): void {
  recipesByConversation.set(conversationId, recipe);
  managersByConversation.delete(conversationId);
}

/**
 * Resolve the manager for a conversation, building it from the registered
 * recipe on first access (get-or-create). Returns `undefined` when no recipe is
 * registered — the conversation was never constructed or has been torn down.
 * The store is the single owner of the instance; the conversation, its agent
 * loop, and the compaction surface all read through this lookup rather than
 * holding their own handle.
 */
export function getContextWindowManager(
  conversationId: string,
): ContextWindowManager | undefined {
  const existing = managersByConversation.get(conversationId);
  if (existing !== undefined) {
    return existing;
  }
  const recipe = recipesByConversation.get(conversationId);
  if (recipe === undefined) {
    return undefined;
  }
  const manager = new ContextWindowManager(recipe());
  managersByConversation.set(conversationId, manager);
  return manager;
}

/**
 * Release the recipe and any built manager for a conversation. Called from
 * conversation teardown so the store releases both once the conversation is
 * gone.
 */
export function disposeContextWindowManager(conversationId: string): void {
  managersByConversation.delete(conversationId);
  recipesByConversation.delete(conversationId);
}
