/**
 * `file_write` and `host_file_write` carry the whole file in `content`, which
 * is the one place the generic body still prints a file as a JSON string
 * literal: quotes escaped, every newline shown as the characters `\n`.
 *
 * Shown as content under its path instead, the way `file_edit` shows a diff.
 * Deliberately not rendered as an all-addition diff: a write replaces whatever
 * was there and the call carries no "before", so gutters and plus signs would
 * claim to know something about the previous file that we do not know.
 */

import { Typography } from "@vellumai/design-library";

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import {
  FILE_PATH_KEYS,
  readToolInputString,
} from "@/domains/chat/utils/tool-input";
import { useTranslation } from "@/i18n";

export function FileWriteDetail({ detail }: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const path = readToolInputString(detail.input, ...FILE_PATH_KEYS);
  // Read raw, not through the shared reader: a file's leading and trailing
  // whitespace is part of the file, and a whitespace-only write is content.
  const content =
    typeof detail.input.content === "string" ? detail.input.content : "";

  return (
    <div>
      <SectionLabel>{t("toolDetailPanel.content")}</SectionLabel>
      {path && (
        <Typography
          variant="body-small-lighter"
          as="div"
          className="mb-1.5 truncate font-mono text-[var(--content-tertiary)]"
        >
          {path}
        </Typography>
      )}
      <CodeBlock text={content} />
    </div>
  );
}
