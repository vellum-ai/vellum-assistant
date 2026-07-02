/**
 * Dependency-injection seam letting the low-level hook pipeline resolve a
 * conversation's effective plugin scope by id without importing daemon
 * internals (which would form a `plugins/` → `daemon/` module cycle).
 *
 * The daemon registers the resolver once at plugin bootstrap
 * (`registerConversationPluginScope` in `daemon/conversation-plugin-scope.ts`);
 * `runHook` reads the scope through {@link resolveConversationPluginScope} when
 * a hook context carries a `conversationId`. When no resolver is registered
 * (lightweight loops, workflows, tests), resolution returns `null` — meaning no
 * per-chat restriction, so every globally-enabled plugin's hooks run.
 */

/** Resolve a conversation's effective plugin scope; `null` = no restriction. */
export type ConversationPluginScopeResolver = (
  conversationId: string,
) => Set<string> | null;

let resolver: ConversationPluginScopeResolver | null = null;

/** Install (or clear, with `null`) the conversation plugin-scope resolver. */
export function registerConversationPluginScopeResolver(
  fn: ConversationPluginScopeResolver | null,
): void {
  resolver = fn;
}

/**
 * Resolve `conversationId`'s effective plugin scope via the registered
 * resolver. Returns `null` when no resolver is installed or the conversation
 * has no per-chat restriction.
 */
export function resolveConversationPluginScope(
  conversationId: string,
): Set<string> | null {
  return resolver ? resolver(conversationId) : null;
}
