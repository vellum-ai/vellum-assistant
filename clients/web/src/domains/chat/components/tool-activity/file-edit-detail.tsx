/**
 * `file_edit` sends `old_string` and `new_string`, which is a diff, so it
 * renders as one rather than as two JSON string literals with their newlines
 * escaped.
 *
 * The diff itself is `FileDiffView`, which ACP runs already use and which
 * soft-wraps rather than scrolling, the thing that makes a diff legible in a
 * 400px drawer. It lives under `acp-run-chat-view/` and now has a second
 * consumer, so it wants lifting to a shared home.
 */

import { Typography } from "@vellumai/design-library";

import { SectionLabel } from "@/components/detail-primitives";
import { FileDiffView } from "@/domains/chat/components/acp-run-chat-view/file-diff-view";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { useTranslation } from "@/i18n";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function FileEditDetail({ detail }: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const path = str(detail.input.path);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionLabel>{t("toolDetailPanel.changes")}</SectionLabel>
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
