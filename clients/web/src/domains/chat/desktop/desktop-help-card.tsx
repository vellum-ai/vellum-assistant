import { Button, Card, Typography } from "@vellumai/design-library";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import type { QuestionEntry } from "@/types/interaction-ui-types";

import { useDesktopPreviewStore } from "./desktop-preview-store";
import { useVirtualDesktopEnabled } from "./use-virtual-desktop-enabled";

interface DesktopHelpCardProps {
  entry: QuestionEntry;
  isSubmitting: boolean;
  onSubmit: (responses: QuestionResponseEntry[]) => void;
}

export function DesktopHelpCard({
  entry,
  isSubmitting,
  onSubmit,
}: DesktopHelpCardProps) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const messageRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const message = messageRef.current;
    if (!message || expanded) {
      return;
    }
    const measure = () =>
      setCanExpand(message.scrollHeight > message.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(message);
    return () => observer.disconnect();
  }, [entry.question, expanded]);
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const enabled = useVirtualDesktopEnabled();
  const session = useDesktopPreviewStore.use.session();
  const attachPreview = useCallback(
    (container: HTMLDivElement | null) => {
      useDesktopPreviewStore
        .getState()
        .setInlinePreview(
          container && assistantId && enabled
            ? { assistantId, container }
            : null,
        );
    },
    [assistantId, enabled],
  );

  return (
    <Card.Root noPadding className="w-full max-w-sm overflow-hidden">
      <div className="p-3">
        <Typography
          as="p"
          ref={messageRef}
          variant="body-small-default"
          className={
            expanded
              ? "break-words leading-normal"
              : "line-clamp-3 break-words leading-normal"
          }
        >
          {entry.question}
        </Typography>
        {canExpand && (
          <Button
            variant="ghost"
            size="compact"
            expandOnMobile={false}
            aria-expanded={expanded}
            className="mt-1"
            onClick={() => setExpanded(!expanded)}
          >
            {t(
              expanded
                ? "desktopHelpCard.showLess"
                : "desktopHelpCard.showMore",
            )}
          </Button>
        )}
      </div>
      {enabled && assistantId ? (
        <div
          ref={attachPreview}
          className="aspect-video w-full overflow-hidden bg-black"
        >
          {session?.assistantId !== assistantId && (
            <Button
              variant="ghost"
              disabled={isSubmitting}
              className="h-full w-full rounded-none text-white"
              onClick={() =>
                useDesktopPreviewStore.getState().openPreview(assistantId)
              }
            >
              {t("desktopHelpCard.showPreview")}
            </Button>
          )}
        </div>
      ) : (
        <Typography variant="body-small-default" className="px-3 pb-3">
          {t("assistantDesktop.unavailable")}
        </Typography>
      )}
      <div className="flex items-center gap-2 p-3">
        <Button
          size="compact"
          expandOnMobile={false}
          variant="outlined"
          disabled={isSubmitting || !enabled || !assistantId}
          onClick={() => {
            if (assistantId) {
              useDesktopPreviewStore.getState().openFullscreen(assistantId);
            }
          }}
        >
          {t("desktopHelpCard.stepIn")}
        </Button>
        <Button
          size="compact"
          expandOnMobile={false}
          disabled={isSubmitting}
          onClick={() =>
            onSubmit([
              { questionId: entry.id, kind: "option", optionId: "done" },
            ])
          }
        >
          {t("desktopHelpCard.done")}
        </Button>
        <Button
          size="compact"
          expandOnMobile={false}
          variant="ghost"
          className="ml-auto"
          disabled={isSubmitting}
          onClick={() => onSubmit([{ questionId: entry.id, kind: "skip" }])}
        >
          {t("desktopHelpCard.skip")}
        </Button>
      </div>
    </Card.Root>
  );
}
