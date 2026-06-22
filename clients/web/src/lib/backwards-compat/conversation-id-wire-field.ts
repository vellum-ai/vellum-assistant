/**
 * Backwards-compat gate: conversation-id wire field on POST /v1/messages
 * and GET /v1/events.
 *
 * The daemon's `handleSendMessage` and `handleSubscribeAssistantEvents`
 * accept either `conversationKey` (external-key lookup; materializes a
 * row on first use) or `conversationId` (direct internal-id lookup;
 * 404 on miss). Web mints draft conversation ids locally — see
 * `createDraftConversationId()` in
 * `domains/chat/utils/conversation-selection.ts` — and uses them as URL
 * keys before the daemon has minted anything, so the strict-lookup
 * `conversationId` path is unsafe for the first message of a new chat.
 * The gate stays parked above the current daemon version until the
 * draft-id flow moves to "daemon mints on first send, UI navigates on
 * the response"; at that point this whole module is removable.
 *
 * NOTE: this helper reads the version snapshot via
 * `useAssistantIdentityStore.getState()` rather than the `use.version()`
 * hook selector, so it's safe to call from non-hook contexts (event
 * handlers, async ops like `postChatMessage`).
 * For React-render paths that should re-render when the version flips,
 * use `useAssistantSupports(MIN_VERSION)` from `./utils.ts` directly.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { compareParsed, parseSemver } from "@/utils/semver";

const MIN_VERSION = "0.8.6";

export type ConversationIdWireField = "conversationId" | "conversationKey";

/**
 * Picks the conversation-id wire field for the currently-active
 * assistant.
 *
 * - Returns `"conversationKey"` when the assistant version is unknown
 *   (identity not yet hydrated) or unparseable. Old daemons silently
 *   ignore `conversationId`, so falling back to the legacy field is
 *   strictly safer than guessing.
 * - Pre-release suffixes on the patch version are ignored:
 *   `0.8.6-rc.1` counts as `0.8.6`. Testers on RCs get the new path
 *   the moment the patch version bumps.
 */
export function pickConversationIdWireField(): ConversationIdWireField {
  const version = useAssistantIdentityStore.getState().version;
  if (!version) return "conversationKey";
  const parsed = parseSemver(version);
  const min = parseSemver(MIN_VERSION);
  if (!parsed || !min) return "conversationKey";
  return compareParsed({ ...parsed, pre: null }, min) >= 0
    ? "conversationId"
    : "conversationKey";
}
