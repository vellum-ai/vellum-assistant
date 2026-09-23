import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import {
  AnimatedStatSquare,
  formatNumber,
} from "@/domains/chat/components/animated-stat-square";
import { DetailShellNotice } from "@/components/detail-shell";
import { ClampedContent, SectionLabel } from "@/components/detail-primitives";
import type { WorkflowLeaf } from "@/domains/chat/workflow-store";
import { useTranslation } from "@/i18n";

/** A labeled text block in the leaf detail — the prompt or the result. */
function DetailSection({
  title,
  body,
  emptyText,
}: {
  title: string;
  body?: string;
  emptyText: string;
}) {
  return (
    <div>
      <SectionLabel as="h3">{title}</SectionLabel>
      {body ? (
        <ClampedContent label={title}>
          <Typography
            variant="body-medium-lighter"
            as="p"
            className="whitespace-pre-wrap break-words leading-relaxed text-[var(--content-default)]"
          >
            {body}
          </Typography>
        </ClampedContent>
      ) : (
        <DetailShellNotice placement="section">{emptyText}</DetailShellNotice>
      )}
    </div>
  );
}

/**
 * Nested detail view for a single workflow leaf (subagent), shown when its row
 * in the list is clicked. Token metrics plus the prompt and result summaries as
 * two separate, labeled sections — never blended into one line. The result is
 * empty until the leaf finishes, so a running leaf shows a "Running…" state.
 */
export function WorkflowLeafDetail({ leaf }: { leaf: WorkflowLeaf }) {
  const { t } = useTranslation("chat");
  const resultEmptyText =
    leaf.status === "running"
      ? t("workflowLeafDetail.running")
      : t("workflowLeafDetail.noResultSummary");

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3">
        <AnimatedStatSquare
          icon={<ArrowDownToLine />}
          target={leaf.inputTokens ?? 0}
          format={(n) => formatNumber(Math.round(n))}
          label={t("workflowLeafDetail.input")}
        />
        <AnimatedStatSquare
          icon={<ArrowUpFromLine />}
          target={leaf.outputTokens ?? 0}
          format={(n) => formatNumber(Math.round(n))}
          label={t("workflowLeafDetail.output")}
        />
      </div>
      <DetailSection
        title={t("workflowLeafDetail.prompt")}
        body={leaf.promptSummary}
        emptyText={t("workflowLeafDetail.noPromptSummary")}
      />
      <DetailSection
        title={t("workflowLeafDetail.result")}
        body={leaf.resultSummary}
        emptyText={resultEmptyText}
      />
    </div>
  );
}
