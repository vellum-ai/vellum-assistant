import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * Whether the viewer may use the internal thread affordances: fork ('Fork
 * from here' on a message, 'Fork Conversation' in the thread menu), 'Summarize
 * up to here', 'Analyze Conversation', 'Copy Full Conversation', 'Copy
 * conversation ID', 'Open in New Window', 'Refresh', message bookmarks, and
 * the LLM inspector surfaces behind them. They all read this one predicate, so
 * widening or narrowing the audience moves them together.
 *
 * The `internal-thread-actions` client flag is the sole gate. It defaults
 * off, so the affordances are opt-in for any session that enables it,
 * including local-gateway sessions, which carry no platform identity. The
 * flag reads as its registry default (`false`) until `/feature-flags`
 * hydrates, so the affordances appear once the real value lands rather than
 * flashing and disappearing.
 *
 * The platform serves this gate under either `internal-thread-actions` or the
 * legacy `fork-from-message` key, and either one grants access. Both are
 * declared in the registry so the flag mapper keeps whichever the platform
 * sends (`use-client-feature-flag-sync.ts` drops keys the registry does not
 * declare).
 */
export function useCanUseInternalThreadActions(): boolean {
  const internalThreadActionsEnabled =
    useClientFeatureFlagStore.use.internalThreadActions();
  const legacyForkFlagEnabled =
    useClientFeatureFlagStore.use.forkFromMessage();
  return internalThreadActionsEnabled === true || legacyForkFlagEnabled === true;
}
