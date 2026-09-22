import { Camera } from "lucide-react";
import { useMemo } from "react";
import { Typography } from "@vellumai/design-library";

import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import { useAttachmentSquares } from "@/domains/chat/components/chat-attachments/use-attachment-squares";
import type {
  DisplayAttachment,
  DisplayMessage,
} from "@/domains/chat/types/types";
import { formatLocale, useTranslation } from "@/i18n";
import {
  formatCompactLocalDate,
  formatLocalTimeWithSeconds,
} from "@/utils/format-date";

interface CameraFrameGridProps {
  frames: DisplayMessage[];
  assistantId?: string | null;
}

/** Every loaded frame keeps its own anchor, including while its image loads. */
export function CameraFrameGrid({ frames, assistantId }: CameraFrameGridProps) {
  const { t } = useTranslation("chat");
  const locale = formatLocale();
  const { attachments, attachmentKeys, tiles, savedTimes } = useMemo(() => {
    const attachments: DisplayAttachment[] = [];
    const attachmentKeys: string[] = [];
    const tiles = frames.map((frame) => {
      const attachment = frame.attachments?.[0];
      if (attachment) {
        attachmentKeys.push(frame.id);
      }
      const attachmentIndex = attachment
        ? attachments.push(attachment) - 1
        : null;
      const date = frame.timestamp == null ? null : new Date(frame.timestamp);
      const hasTime = date !== null && Number.isFinite(date.getTime());
      return {
        id: frame.id,
        attachmentIndex,
        time: hasTime
          ? formatLocalTimeWithSeconds(date.getTime(), locale)
          : null,
        dateTime: hasTime
          ? formatCompactLocalDate(date.toISOString(), { includeSeconds: true })
          : null,
      };
    });
    const savedTimes = tiles.flatMap((tile) =>
      tile.dateTime ? [tile.dateTime] : [],
    );
    return { attachments, attachmentKeys, tiles, savedTimes };
  }, [frames, locale]);
  const { displayAttachments, renderSquare, previewModal } =
    useAttachmentSquares({ attachments, attachmentKeys, assistantId });

  if (tiles.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)]"
      >
        {t("cameraFrameGrid.count", { count: tiles.length })}
      </Typography>
      {savedTimes.length > 1 && (
        <Typography
          variant="label-small-default"
          className="text-[var(--content-secondary)]"
        >
          {t("cameraFrameGrid.timeRange", {
            first: savedTimes[0],
            last: savedTimes[savedTimes.length - 1],
          })}
        </Typography>
      )}
      <div className="flex flex-wrap items-start gap-2">
        {tiles.map((tile) => {
          const savedTime = tile.dateTime
            ? t("cameraFrameGrid.savedTime", { time: tile.dateTime })
            : t("cameraFrameGrid.timeUnavailable");
          const labels = {
            primary: tile.time ?? t("cameraFrameGrid.timeUnavailable"),
            secondary: null,
            title: savedTime,
            ariaLabel: savedTime,
          };
          const attachment =
            tile.attachmentIndex === null
              ? undefined
              : displayAttachments[tile.attachmentIndex];
          return (
            <div key={tile.id} id={`msg-${tile.id}`} data-message-id={tile.id}>
              {attachment && tile.attachmentIndex !== null ? (
                renderSquare(attachment, tile.attachmentIndex, labels)
              ) : (
                <MessageAttachmentSquare
                  attachment={null}
                  placeholder={<Camera aria-hidden className="h-6 w-6" />}
                  labels={{
                    ...labels,
                    ariaLabel: t("cameraFrameGrid.pendingAria", {
                      time: savedTime,
                    }),
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      {previewModal}
    </div>
  );
}
