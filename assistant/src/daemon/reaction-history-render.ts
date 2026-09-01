/**
 * Render a persisted reaction row into the text the model reads.
 *
 * A reaction is stored as a user row whose content is the "[reaction]"
 * sentinel; the fact lives in the row's metadata (`providerMeta.reaction`:
 * who reacted, with which emoji, on which message). The stored row stays
 * canonical and rendering happens at history-load time, so every stored row
 * renders regardless of when it was written and no formatting is frozen
 * into persistence.
 *
 * Two authorship contracts share the renderer. An inbound row (role user)
 * is sender activity: the actor's display name and the quoted target are
 * sender-authored, so the whole line is fenced as untrusted content the
 * same way channel text is fenced at ingress (`inbound-content-prep.ts`).
 * A self-authored row (role assistant, written by the react tool) renders
 * second-person with the verb unfenced, but the quoted target stays
 * fenced: the emoji and act are the model's own output, the text it
 * reacted to is not.
 *
 * Serves consumers of `Conversation.loadFromDb` history. Slack channel
 * turns build their provider history from rows instead and render
 * reactions through their own transcript renderer
 * (`messaging/providers/slack/render-transcript.ts`), whose tag-line
 * format references targets by alias rather than by quote.
 */
import type { ProviderMessageMetadata } from "../messaging/provider-message-metadata.js";
import {
  unwrapExternalContentForDisplay,
  wrapUntrustedContent,
} from "../security/untrusted-content.js";

/**
 * Slack-style emoji names render in colon form. Anything else (a unicode
 * emoji, Discord's `<:name:id>` mention form) is already self-delimiting.
 */
const EMOJI_NAME_PATTERN = /^[\w+'-]+$/;

const TARGET_SNIPPET_MAX_CHARS = 120;

function formatEmoji(emoji: string): string {
  return EMOJI_NAME_PATTERN.test(emoji) ? `:${emoji}:` : emoji;
}

/**
 * Flatten a quoted target to one line: the ingress fence is markup around
 * the target's own text, not part of it, so it is unwrapped rather than
 * quoted.
 */
function snippetOf(text: string): string {
  const flat = unwrapExternalContentForDisplay(text)
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= TARGET_SNIPPET_MAX_CHARS) {
    return flat;
  }
  return `${flat.slice(0, TARGET_SNIPPET_MAX_CHARS)}...`;
}

/**
 * The readable line for a reaction row, fenced, or null when the metadata
 * does not describe a reaction (callers keep the row's stored content then).
 *
 * `resolveTargetText` maps the reaction's `targetMessageId` to the target
 * row's text in the same provider id namespace; returning undefined (target
 * compacted away, or never stored) degrades to "an earlier message".
 */
export function renderReactionHistoryText(
  meta: ProviderMessageMetadata,
  resolveTargetText: (targetMessageId: string) => string | undefined,
  options?: {
    /**
     * The row is the assistant's own reaction (an assistant-role row the
     * react tool persisted). Rendered second-person and unfenced: the actor
     * and emoji are the model's own output, not sender-authored text.
     */
    selfAuthored?: boolean;
  },
): string | null {
  if (meta.eventKind !== "reaction" || !meta.reaction) {
    return null;
  }
  const { emoji, op, targetMessageId } = meta.reaction;
  const target = resolveTargetText(targetMessageId);
  const snippet = target ? snippetOf(target) : "";

  if (options?.selfAuthored) {
    const verb =
      op === "removed"
        ? `removed your ${formatEmoji(emoji)} reaction from`
        : `reacted with ${formatEmoji(emoji)} to`;
    if (!snippet) {
      return `You ${verb} an earlier message`;
    }
    // The quoted target is sender-authored text entering an assistant-role
    // message; unfenced it would replay as trusted content, so a sender
    // could plant instructions and induce a reaction to launder them.
    const fencedSnippet = wrapUntrustedContent(snippet, {
      source: meta.source === "slack" ? "slack" : "webhook",
    });
    return `You ${verb} this message: ${fencedSnippet}`;
  }

  const actor = meta.reaction.actorDisplayName ?? meta.displayName ?? "Someone";
  const verb =
    op === "removed"
      ? `removed their ${formatEmoji(emoji)} reaction from`
      : `reacted with ${formatEmoji(emoji)} to`;
  const line = snippet
    ? `${actor} ${verb} the message "${snippet}"`
    : `${actor} ${verb} an earlier message`;
  return wrapUntrustedContent(line, {
    source: meta.source === "slack" ? "slack" : "webhook",
    ...(meta.actorExternalId ? { sourceDetail: meta.actorExternalId } : {}),
  });
}
