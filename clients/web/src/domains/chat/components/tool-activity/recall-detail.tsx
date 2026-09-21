/**
 * The body for a `recall` call: what was searched for and where, the answer
 * written from what turned up, and the evidence it stands on. The generic
 * drawer showed the query as JSON and all of the rest as one block of text,
 * the answer, a numbered evidence list and a footer of searched sources run
 * together.
 *
 * Everything past the query comes from the call's structured result. History
 * recorded before `recall` reported one shows its text instead, as plain text:
 * its numbered lines and footer are not markdown, and would run together if
 * read as it.
 */

import type { RecallMetadata } from "@vellumai/assistant-api";
import { Notice, Typography } from "@vellumai/design-library";

import {
  ClampedContent,
  DetailBlock,
  SectionLabel,
} from "@/components/detail-primitives";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { RecallEvidenceList } from "@/domains/chat/components/tool-activity/recall-evidence-list";
import {
  useRecallDepthLabel,
  useRecallSourceLabel,
} from "@/domains/chat/components/tool-activity/recall-labels";
import { ToolOutputBody } from "@/domains/chat/components/tool-activity/tool-output-body";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { readToolInputString } from "@/domains/chat/utils/tool-input";
import { currentLocale, useTranslation } from "@/i18n";

/** How hard recall searched, and where. */
function RecallScope({ recall }: { recall: RecallMetadata }) {
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

/** The places recall could not fully search, and why, when there are any. */
function DegradedSources({ recall }: { recall: RecallMetadata }) {
  const { t } = useTranslation("chat");
  const sourceLabel = useRecallSourceLabel();
  const degraded = recall.searchedSources.filter(
    (note) => note.status === "degraded",
  );
  if (degraded.length === 0) {
    return null;
  }
  return (
    <Notice tone="warning" title={t("recallDetail.degraded")}>
      <ul className="flex flex-col gap-1">
        {degraded.map((note) => (
          <li key={note.source} className="break-words">
            {note.error
              ? t("recallDetail.degradedSource", {
                  source: sourceLabel(note.source),
                  error: note.error,
                })
              : sourceLabel(note.source)}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

function RecallResult({
  recall,
  assistantId,
}: {
  recall: RecallMetadata;
  assistantId?: string | null;
}) {
  const { t } = useTranslation("chat");
  const evidenceLabel = t("recallDetail.evidence", {
    count: recall.evidence.length,
  });
  return (
    <>
      <DegradedSources recall={recall} />
      {recall.answer && (
        <div>
          <SectionLabel>{t("recallDetail.answer")}</SectionLabel>
          <DetailBlock variant="filled">
            <ChatMarkdownMessage
              content={recall.answer}
              assistantId={assistantId}
            />
          </DetailBlock>
        </div>
      )}
      {recall.evidence.length > 0 ? (
        <div>
          <SectionLabel>{evidenceLabel}</SectionLabel>
          <ClampedContent label={evidenceLabel}>
            <RecallEvidenceList evidence={recall.evidence} />
          </ClampedContent>
        </div>
      ) : (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--content-tertiary)]"
        >
          {t("recallDetail.noEvidence")}
        </Typography>
      )}
    </>
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
