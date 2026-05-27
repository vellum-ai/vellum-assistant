/**
 * Backwards-compat gate: server-minted conversations on first send.
 *
 * On assistants that support this flow, the web client doesn't mint a
 * draft conversation id locally. The `+` button navigates to bare
 * `/assistant`, the first POST omits both `conversationId` and
 * `conversationKey`, and the assistant's response carries the freshly
 * minted conversation id — the UI then navigates to
 * `/assistant/conversations/{id}` and continues normally.
 *
 * On older assistants that don't know about this flow, an empty-handed
 * `sourceChannel: "vellum"` send falls through to the shared
 * `default:vellum:<interface>` thread, which would dump every "new"
 * chat into the same conversation. To stay safe there, the legacy
 * path (mint a UUID locally, send it as `conversationKey`) is kept
 * behind this gate until every supported assistant understands the new
 * flow.
 */
import { assistantSupports } from "./utils";

export const MIN_VERSION = "0.8.6";

/**
 * Returns `true` when the active assistant mints a conversation on
 * any `sourceChannel: "vellum"` send that arrives without a
 * `conversationId` or `conversationKey`.
 *
 * Reads the identity-store snapshot rather than subscribing via a hook
 * selector so it's safe to call from non-hook contexts (event handlers,
 * async ops like `postChatMessage`). React-render paths that should
 * re-render when the version flips must use `useAssistantSupports`
 * from `./utils.ts` directly.
 *
 * Returns `false` while the identity store has no version yet, when
 * the version is unparseable, or when it falls below `MIN_VERSION`.
 * Callers must keep the legacy draft-UUID flow alive on the `false`
 * branch.
 */
export function supportsServerMintedConversation(): boolean {
  return assistantSupports(MIN_VERSION);
}
