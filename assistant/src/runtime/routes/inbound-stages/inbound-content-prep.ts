/**
 * Prepare channel-inbound message content for a turn.
 *
 * A non-guardian channel message is untrusted external data, so its text is
 * fenced in `<external_content>` boundaries (via {@link wrapUntrustedContent})
 * before it enters model context — the model is instructed never to follow
 * instructions found inside those boundaries. Guardian messages are trusted and
 * pass through unwrapped. Slack additionally keeps the raw text as
 * `displayContent` so the UI shows the message the sender actually typed.
 *
 * Shared by the live ingress path (`inbound-message-handler.ts`) and the retry
 * sweep (`channel-retry-sweep.ts`) so both prepare content identically: a turn
 * replayed from the stored payload is fenced exactly as its first run, and the
 * boundary cannot be skipped on a retry or crash-recovery path.
 */
import type { ChannelId } from "../../../channels/types.js";
import type { TrustContext } from "../../../daemon/trust-context-types.js";
import { wrapUntrustedContent } from "../../../security/untrusted-content.js";

export interface PreparedChannelInboundContent {
  /**
   * Model-facing content. For non-guardian senders this is `trimmedContent`
   * fenced in an `<external_content>` boundary; for guardians it is the raw
   * `trimmedContent`.
   */
  content: string;
  /**
   * User-facing display copy (the raw, unwrapped text) persisted alongside the
   * model content so the UI renders what the sender typed rather than the
   * boundary-wrapped form. Set only for non-guardian Slack turns, matching the
   * live ingress path; absent otherwise (persistence falls back to `content`).
   */
  displayContent?: string;
}

/**
 * Fence untrusted (non-guardian) channel content and derive the display copy.
 * Pure and side-effect free so both the live ingress path and the retry sweep
 * can call it and get byte-identical results for the same inputs.
 */
export function prepareChannelInboundContent(params: {
  trimmedContent: string;
  trustClass: TrustContext["trustClass"];
  sourceChannel: ChannelId;
  requesterIdentifier?: string;
}): PreparedChannelInboundContent {
  const { trimmedContent, trustClass, sourceChannel, requesterIdentifier } =
    params;

  const isGuardian = trustClass === "guardian";
  const content = isGuardian
    ? trimmedContent
    : wrapUntrustedContent(trimmedContent, {
        source: sourceChannel === "slack" ? "slack" : "webhook",
        sourceDetail: requesterIdentifier,
      });

  // Slack persists the raw text as display copy for non-guardian turns so the
  // transcript shows the sender's words, not the wrapped form.
  if (!isGuardian && sourceChannel === "slack") {
    return { content, displayContent: trimmedContent };
  }
  return { content };
}
