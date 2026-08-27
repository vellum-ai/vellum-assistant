/**
 * The read-only channel drawer's rendering surface: header shell, read-only
 * note, entry rows, and empty states, drawn purely from props.
 *
 * Prop-driven by design so the surface has two mounts. `ChannelTranscriptPanel`
 * is the production container: it owns every store and query read and passes
 * the derived thread down. Storybook mounts this directly on fixtures. Nothing
 * here reads a store or a query, so what the stories show is exactly what the
 * container renders.
 *
 * It has no composer by design. The Vellum composer is the only input, and the
 * only way out of here toward the channel is the source link in the header.
 */

import { Button, Tag, Typography } from "@vellumai/design-library";
import { ExternalLink } from "lucide-react";

import { channelReportsMessageProvenance } from "@/domains/chat/channel-sidecar/channel-message-provenance";
import type { ChannelTranscriptEntry } from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";
import { ChannelTranscriptEntryRow } from "@/domains/chat/channel-sidecar/channel-transcript-entry-row";
import { DetailShell } from "@/components/detail-shell";
import { useTranslation } from "@/i18n";
import type { ChannelSidecarRef } from "@/stores/viewer-store";
import { ChannelIcon, getChannelLabel } from "@/utils/channel-presentation";
import { handleNativeAnchorClick } from "@/utils/native-anchor";

export interface ChannelTranscriptPanelViewProps {
  /** Thread the drawer is showing. Names the channel for the icon and copy. */
  sidecarRef: ChannelSidecarRef;
  /**
   * The thread's own name, when the channel reports one. Absent degrades the
   * heading to the bare channel name rather than showing an opaque id.
   */
  threadName?: string;
  /** Deep link back into the source channel. Absent hides the header action. */
  sourceHref?: string;
  /** Rows of the external thread, oldest first. */
  entries: ChannelTranscriptEntry[];
  /**
   * What to call an assistant row the channel named no sender for. The
   * assistant answers in the channel under its own name, so "unknown" there
   * would be wrong rather than merely vague.
   */
  assistantName: string | null;
  /** Row currently staged on the Vellum composer, or `null` when none is. */
  referencedEntryId: string | null;
  onToggleReference: (entry: ChannelTranscriptEntry) => void;
  onClose: () => void;
}

export function ChannelTranscriptPanelView({
  sidecarRef,
  threadName,
  sourceHref,
  entries,
  assistantName,
  referencedEntryId,
  onToggleReference,
  onClose,
}: ChannelTranscriptPanelViewProps) {
  const { t } = useTranslation("chat");
  const channelLabel = getChannelLabel(sidecarRef.channelId);
  const heading = threadName
    ? t("channelTranscriptPanel.namedTitle", {
        channel: channelLabel,
        thread: threadName,
      })
    : t("channelTranscriptPanel.title", { channel: channelLabel });

  return (
    <DetailShell
      icon={
        <ChannelIcon
          channelId={sidecarRef.channelId}
          className="h-5 w-5 shrink-0 text-[var(--content-secondary)]"
        />
      }
      title={heading}
      headerTrailing={
        <Tag tone="neutral">{t("channelTranscriptPanel.readOnly")}</Tag>
      }
      headerActions={
        sourceHref ? (
          <Button
            asChild
            variant="outlined"
            leftIcon={<ExternalLink />}
            className="shrink-0"
          >
            <a
              href={sourceHref}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => handleNativeAnchorClick(e, sourceHref)}
            >
              {t("channelTranscriptPanel.openInChannel", {
                channel: channelLabel,
              })}
            </a>
          </Button>
        ) : undefined
      }
      closeLabel={t("channelTranscriptPanel.closeAria")}
      closeTooltip={t("channelTranscriptPanel.closeTooltip")}
      onClose={onClose}
    >
      <Typography
        as="p"
        variant="body-small-lighter"
        className="mb-3 text-[var(--content-tertiary)]"
      >
        {t("channelTranscriptPanel.readOnlyNote", { channel: channelLabel })}
      </Typography>

      {entries.length === 0 ? (
        <Typography
          as="p"
          variant="body-small-default"
          className="py-4 text-center text-[var(--content-tertiary)]"
        >
          {channelReportsMessageProvenance(sidecarRef.channelId)
            ? t("channelTranscriptPanel.emptyThread", { channel: channelLabel })
            : t("channelTranscriptPanel.emptyNoMessageDetail", {
                channel: channelLabel,
              })}
        </Typography>
      ) : (
        <div className="flex flex-col gap-1">
          {entries.map((entry) => (
            <ChannelTranscriptEntryRow
              key={entry.id}
              entry={entry}
              channelLabel={channelLabel}
              assistantName={assistantName}
              isReferenced={referencedEntryId === entry.id}
              onToggleReference={onToggleReference}
            />
          ))}
        </div>
      )}
    </DetailShell>
  );
}
