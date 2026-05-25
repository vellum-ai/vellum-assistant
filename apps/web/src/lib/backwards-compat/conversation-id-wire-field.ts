/**
 * Backwards-compat gate: conversation-id wire field on POST /v1/messages
 * and GET /v1/events.
 *
 * Vellum Assistant 0.8.5 (PR #31922) made the daemon bilingual on
 * conversation routing: `handleSendMessage` and
 * `handleSubscribeAssistantEvents` accept either `conversationKey`
 * (legacy external-key lookup; materializes a row on first use) or
 * `conversationId` (direct internal-id lookup; 404 on miss). The web
 * client always has the assistant-minted internal id, so we prefer the
 * canonical `conversationId` field when the assistant supports it.
 *
 * Assistants on 0.8.4 or older only understand `conversationKey`.
 *
 * NOTE: this helper reads the version snapshot via
 * `useAssistantIdentityStore.getState()` rather than the `use.version()`
 * hook selector, so it's safe to call from non-hook contexts (event
 * handlers, async ops like `postChatMessage` / `subscribeChatEvents`).
 * For React-render paths that should re-render when the version flips,
 * use `useAssistantSupports(MIN_VERSION)` from `./utils.ts` directly.
 */
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store.js";
import { compareParsed, parseSemver } from "@/utils/semver.js";

const MIN_VERSION = "0.8.5";

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
 *   `0.8.5-rc.1` counts as `0.8.5`. Testers on RCs get the new path
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
