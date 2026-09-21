/**
 * The body for a `recall` call: what was searched for and where, the answer
 * written from what turned up, and the evidence it stands on.
 *
 * Everything past the query comes from the call's structured result. A call
 * without one shows its text as plain text, since its numbered lines and
 * footer are not markdown.
 */

import type { RecallMetadata } from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

import { DetailBlock, SectionLabel } from "@/components/detail-primitives";
import {
  useRecallDepthLabel,
  useRecallSourceLabel,
} from "@/domains/chat/components/tool-activity/recall-labels";
import { RecallResult } from "@/domains/chat/components/tool-activity/recall-result";
import { ToolOutputBody } from "@/domains/chat/components/tool-activity/tool-output-body";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { readToolInputString } from "@/domains/chat/utils/tool-input";
import { currentLocale, useTranslation } from "@/i18n";

interface RecallScopeProps {
  recall: RecallMetadata;
}

/** How hard recall searched, and where. */
function RecallScope({ recall }: RecallScopeProps) {
  const { t } = useTranslation("chat");
  const depthLabel = useRecallDepthLabel();
  const sourceLabel = useRecallSourceLabel();
  return (
    <Typography
      variant="body-small-lighter"
      as="p"
      className="mt-1 text-[var(--content-tertiary)]"
    >
      {t("recallDetail.scope", {
        depth: depthLabel(recall.depth),
        sources: new Intl.ListFormat(currentLocale(), {
          style: "long",
          type: "conjunction",
        }).format(recall.sources.map(sourceLabel)),
      })}
    </Typography>
  );
}

export function RecallDetail({
  detail,
  result,
  activityMetadata,
  isRunning,
  isError,
  isDenied,
  assistantId,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const recall = activityMetadata?.recall;
  const query = recall?.query || readToolInputString(detail.input, "query");
  const text = typeof result === "string" ? result : "";
  const settled = !isRunning && !isError && !isDenied;

  return (
    <div className="flex flex-col gap-5">
      {query && (
        <div>
          <SectionLabel>{t("recallDetail.searchedFor")}</SectionLabel>
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="break-words text-[var(--content-default)]"
          >
            {query}
          </Typography>
          {recall && <RecallScope recall={recall} />}
        </div>
      )}
      {settled && recall ? (
        <RecallResult recall={recall} assistantId={assistantId} />
      ) : settled && text ? (
        <div>
          <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
          <DetailBlock variant="filled">
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="whitespace-pre-wrap break-words text-[var(--content-default)]"
            >
              {text}
            </Typography>
          </DetailBlock>
        </div>
      ) : (
        <div>
          <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
          <ToolOutputBody
            text={text}
            isDenied={isDenied}
            isRunning={isRunning}
            isError={isError}
          />
        </div>
      )}
    </div>
  );
}
