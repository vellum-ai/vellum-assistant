/**
 * PROPOSAL, not registered. See `tool-detail-proposals.stories.tsx`.
 *
 * `file_edit` sends `old_string` and `new_string`, which is a diff, and the
 * generic block renders it as two JSON string literals with their newlines
 * escaped. This shows it as the diff it is.
 *
 * Nothing here is new machinery: `FileDiffView` already renders a unified diff
 * from a before/after pair for ACP run tool calls, and it soft-wraps rather
 * than scrolling, which is what makes a diff legible in a 400px drawer.
 * Shipping this means lifting that view out of `acp-run-chat-view/` into a
 * shared home, since it would then have two consumers.
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
    <div className="flex flex-col gap-2">
      <SectionLabel className="mb-0">
        {t("toolDetailPanel.changes")}
      </SectionLabel>
      {path && (
        <Typography
          variant="body-small-lighter"
          as="div"
          className="truncate font-mono text-[var(--content-tertiary)]"
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
  );
}
