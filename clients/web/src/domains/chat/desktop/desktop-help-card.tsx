import { Button, Card, Typography } from "@vellumai/design-library";
import { useCallback } from "react";

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
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const enabled = useVirtualDesktopEnabled();
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
    <Card.Root noPadding className="overflow-hidden">
      <div className="space-y-1 p-3">
        <Typography variant="body-medium-default" className="font-medium">
          {entry.question}
        </Typography>
        <Typography
          variant="body-small-default"
          className="text-[var(--content-secondary)]"
        >
          {t("desktopHelpCard.description")}
        </Typography>
      </div>
      {enabled && assistantId ? (
        <div
          ref={attachPreview}
          className="aspect-video w-full overflow-hidden bg-black"
        />
      ) : (
        <Typography variant="body-small-default" className="px-3 pb-3">
          {t("assistantDesktop.unavailable")}
        </Typography>
      )}
      <div className="flex items-center gap-2 p-3">
        <Button
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
