/**
 * One external-channel row inside the read-only channel drawer.
 *
 * A message row carries the single action the drawer offers: staging it as a
 * reference on the Vellum composer. That control uses the shared reveal
 * treatment (`data-reveal`), which keeps it out of the way on a pointer
 * device, paints it on hover and on `:focus-visible`, and shows it outright
 * wherever the device reports `hover: none`. Keyboard and touch therefore
 * both reach it without a hover-only trap.
 *
 * A reaction row is channel activity, not content, and offers no reference
 * control (see `isReferenceableChannelEntry`).
 */

import { Check, CornerUpLeft } from "lucide-react";

import { Button, Typography } from "@vellumai/design-library";
import {
  quoteBlockquoteAccentClassName,
  quoteBlockquoteClassName,
  quoteBlockquoteContentClassName,
} from "@vellumai/design-library/components/markdown-message";

import {
  channelTimestampToIso,
  isReferenceableChannelEntry,
  type ChannelTranscriptEntry,
} from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";
import { useTranslation } from "@/i18n";
import { formatCompactLocalDate, formatFullLocalDate } from "@/utils/format-date";

interface ChannelTranscriptEntryRowProps {
  entry: ChannelTranscriptEntry;
  /** Human channel name, already resolved by the panel. */
  channelLabel: string;
  /**
   * What to call an assistant row the channel named no sender for. The
   * assistant answers in the channel under its own name, so falling back to
   * "unknown" there would be wrong rather than merely vague.
   */
  assistantName: string | null;
  /** Whether this row is the one currently pinned to the composer. */
  isReferenced: boolean;
  onToggleReference: (entry: ChannelTranscriptEntry) => void;
}

export function ChannelTranscriptEntryRow({
  entry,
  channelLabel,
  assistantName,
  isReferenced,
  onToggleReference,
}: ChannelTranscriptEntryRowProps) {
  const { t } = useTranslation("chat");
  const iso = channelTimestampToIso(entry.timestamp);
  const fallbackSender =
    entry.role === "user"
      ? t("channelTranscriptPanel.unknownSender")
      : (assistantName ?? t("channelTranscriptPanel.assistantSender"));
  const sender = entry.provenance.senderName ?? fallbackSender;
  const reaction = entry.provenance.reaction;

  return (
    <article
      data-reveal-row=""
      data-testid="channel-transcript-entry"
      className="group flex flex-col gap-1 rounded-lg px-2 py-2 hover:bg-[var(--surface-active)]"
    >
      <header className="flex min-w-0 items-baseline gap-2">
        <Typography
          as="span"
          variant="body-small-emphasised"
          className="min-w-0 truncate text-[var(--content-default)]"
        >
          {sender}
        </Typography>
        {iso ? (
          <Typography
            as="span"
            variant="body-small-lighter"
            title={formatFullLocalDate(iso)}
            className="shrink-0 text-[var(--content-tertiary)]"
          >
            {formatCompactLocalDate(iso)}
          </Typography>
        ) : null}
        <span className="flex-1" />
        {isReferenceableChannelEntry(entry) ? (
          <Button
            variant="ghost"
            size="compact"
            data-reveal=""
            active={isReferenced}
            leftIcon={isReferenced ? <Check /> : <CornerUpLeft />}
            onClick={() => onToggleReference(entry)}
            aria-pressed={isReferenced}
            aria-label={
              isReferenced
                ? t("channelTranscriptPanel.removeReferenceAria")
                : t("channelTranscriptPanel.referenceAria", {
                    channel: channelLabel,
                  })
            }
            className="shrink-0"
          >
            {isReferenced
              ? t("channelTranscriptPanel.referenced")
              : t("channelTranscriptPanel.reference")}
          </Button>
        ) : null}
      </header>

      {reaction ? (
        <Typography
          as="p"
          variant="body-small-default"
          className="text-[var(--content-secondary)]"
        >
          {reaction.op === "added"
            ? t("channelTranscriptPanel.reactionAdded", {
                emoji: reaction.emoji,
              })
            : t("channelTranscriptPanel.reactionRemoved", {
                emoji: reaction.emoji,
              })}
        </Typography>
      ) : (
        <Typography
          as="div"
          variant="body-small-default"
          className={`${quoteBlockquoteClassName} mb-0`}
        >
          <span aria-hidden="true" className={quoteBlockquoteAccentClassName} />
          <span
            className={`${quoteBlockquoteContentClassName} whitespace-pre-wrap break-words`}
          >
            {entry.text || t("channelTranscriptPanel.noText")}
          </span>
        </Typography>
      )}
    </article>
  );
}
