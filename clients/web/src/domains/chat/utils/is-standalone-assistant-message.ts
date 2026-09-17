import type { DisplayMessage } from "@/domains/chat/types/types";
import { isChannelDeleted } from "@/domains/chat/utils/is-channel-deleted";

/**
 * Whether an assistant row is a standalone display turn: one that renders as
 * something other than assistant speech (a system card, a provider-error
 * notice, a deliberate-silence marker, a reaction, a row deleted on its
 * channel) and so is never folded into, or dropped against, an adjacent
 * assistant row. Every client step that combines neighbouring assistant rows
 * reads this one predicate.
 *
 * Mirrors the daemon's `isStandaloneAssistantMessage`
 * (assistant/src/persistence/conversation-crud.ts), which decides the same
 * for its query-time merge from the stored metadata; this reads the wire
 * projection of the same facts. The two lists change together.
 *
 * A reaction row is one whose wire projection carries the reaction fact, or
 * whose Slack view carries the reaction event kind, the same two reads the
 * render dispatch makes (`getMessageRenderKind`).
 */
export function isStandaloneAssistantMessage(
  message: Pick<
    DisplayMessage,
    | "isSystemCard"
    | "providerError"
    | "isNoResponse"
    | "reaction"
    | "slackMessage"
    | "deletedAt"
  >,
): boolean {
  return (
    message.isSystemCard === true ||
    message.providerError !== undefined ||
    message.isNoResponse === true ||
    message.reaction !== undefined ||
    message.slackMessage?.eventKind === "reaction" ||
    isChannelDeleted(message)
  );
}
