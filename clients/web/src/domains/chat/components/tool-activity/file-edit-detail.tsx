/**
 * `file_edit` sends `old_string` and `new_string`, which is a diff, so it
 * renders as one rather than as two JSON string literals with their newlines
 * escaped.
 *
 * The diff describes what the call asked for. Only a call that succeeded had
 * that applied, so a failed, denied or still-running one labels the section as
 * the requested change instead: a denied edit under a plain "Changes" heading
 * reads as an edit that happened.
 */

import { Typography } from "@vellumai/design-library";

import { SectionLabel } from "@/components/detail-primitives";
import { FileDiffView } from "@/domains/chat/components/file-diff-view";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { useTranslation } from "@/i18n";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function FileEditDetail({
  detail,
  isRunning,
  isError,
  isDenied,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const path = str(detail.input.path);
  const applied = !isRunning && !isError && !isDenied;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionLabel>
          {applied
            ? t("toolDetailPanel.changes")
            : t("toolDetailPanel.requestedChanges")}
        </SectionLabel>
        {path && (
          <Typography
            variant="body-small-lighter"
            as="div"
            className="mb-1.5 truncate font-mono text-[var(--content-tertiary)]"
          >
            {path}
          </Typography>
        )}
        <FileDiffView
          path={path}
          oldText={str(detail.input.old_string)}
          newText={str(detail.input.new_string)}
        />
      </div>
    </div>
  );
}
