/**
 * The places a `recall` could not fully search, and why, as a warning above
 * its result. Renders nothing when every place was searched.
 */

import type { RecallSearchedSource } from "@vellumai/assistant-api";
import { Notice } from "@vellumai/design-library";

import { useRecallSourceLabel } from "@/domains/chat/components/tool-activity/recall-labels";
import { useTranslation } from "@/i18n";

interface RecallDegradedSourcesProps {
  searchedSources: readonly RecallSearchedSource[];
}

export function RecallDegradedSources({
  searchedSources,
}: RecallDegradedSourcesProps) {
  const { t } = useTranslation("chat");
  const sourceLabel = useRecallSourceLabel();
  const degraded = searchedSources.filter((note) => note.status === "degraded");
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
