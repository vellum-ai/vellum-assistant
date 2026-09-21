/**
 * What a `recall` found, from its structured result: any place it could not
 * fully search, the answer written from the evidence, and the evidence itself.
 */

import type { RecallMetadata } from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

import {
  ClampedContent,
  DetailBlock,
  SectionLabel,
} from "@/components/detail-primitives";
import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { RecallDegradedSources } from "@/domains/chat/components/tool-activity/recall-degraded-sources";
import { RecallEvidenceList } from "@/domains/chat/components/tool-activity/recall-evidence-list";
import { useTranslation } from "@/i18n";

interface RecallResultProps {
  recall: RecallMetadata;
  /** Threaded to the answer's markdown so workspace links resolve. */
  assistantId?: string | null;
}

export function RecallResult({ recall, assistantId }: RecallResultProps) {
  const { t } = useTranslation("chat");
  const evidenceLabel = t("recallDetail.evidence", {
    count: recall.evidence.length,
  });
  return (
    <>
      <RecallDegradedSources searchedSources={recall.searchedSources} />
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
            <RecallEvidenceList
              evidence={recall.evidence}
              assistantId={assistantId}
            />
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
