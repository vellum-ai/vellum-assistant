/**
 * The body for every tool that changes one file: `file_edit`, `file_write` and
 * their `host_` twins.
 *
 * One component because the daemon models them as one thing. Its
 * `computePreviewDiff` (`assistant/src/tools/executor.ts`) takes either tool
 * and returns the same `{ filePath, oldContent, newContent, isNewFile }`, so
 * the difference between a write and an edit is not what happened to the file,
 * only how much of the before and after the call carries.
 *
 * One label pair for the same reason. The diff, or the content, is what the
 * call asked for, and only a call that succeeded had it applied, so anything
 * else reads as requested. Sharing a body is what keeps that rule true of
 * every file tool at once.
 */

import { Typography } from "@vellumai/design-library";

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import { FileDiffView } from "@/domains/chat/components/file-diff-view";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import {
  FILE_PATH_KEYS,
  readToolInputString,
} from "@/domains/chat/utils/tool-input";
import { useTranslation } from "@/i18n";

/**
 * Read a side of the change verbatim. Deliberately not `readToolInputString`:
 * a file's whitespace is the file, and a `new_string` of blank lines is
 * content, not an absent field.
 */
function fileText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The tools that name the text they replace. Both sides are known for these,
 * so the change renders as a diff; every other file tool sends only what the
 * file will contain.
 */
const EDIT_TOOL_NAMES = new Set(["file_edit", "host_file_edit"]);

export function FileChangeDetail({
  detail,
  isRunning,
  isError,
  isDenied,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const path = readToolInputString(detail.input, ...FILE_PATH_KEYS);
  const applied = !isRunning && !isError && !isDenied;

  // Which rendering to use follows the tool, not the input keys. The write
  // schemas are `z.looseObject`, so a write can carry a stray `old_string`
  // without being invalid, and keying off that would show an empty diff in
  // place of the file the call actually writes.
  const isEdit = EDIT_TOOL_NAMES.has(detail.toolName.toLowerCase());

  return (
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
      {isEdit ? (
        <FileDiffView
          path={path}
          oldText={fileText(detail.input.old_string)}
          newText={fileText(detail.input.new_string)}
        />
      ) : (
        <CodeBlock text={fileText(detail.input.content)} />
      )}
    </div>
  );
}
