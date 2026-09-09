/**
 * The body for every tool that changes one file: `file_edit`, `file_write` and
 * their `host_` twins.
 *
 * One component because the daemon already models them as one thing. Its
 * `computePreviewDiff` (`assistant/src/tools/executor.ts`) takes either tool
 * and returns the same `{ filePath, oldContent, newContent, isNewFile }`, so
 * the difference between a write and an edit is not what happened to the file,
 * only how much of the before-and-after the call carries: an edit sends both
 * sides, a write sends the after.
 *
 * That is also why the label is one pair rather than per-tool wording. The
 * diff, or the content, describes what the call *asked for*, and only a call
 * that succeeded had it applied, so anything else reads as requested. Keeping
 * that in one place is the point: it was written for the edit body, and a
 * second body written alongside it did not have it, so a declined write
 * presented its content as a file that had been written.
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

export function FileChangeDetail({
  detail,
  isRunning,
  isError,
  isDenied,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const path = readToolInputString(detail.input, ...FILE_PATH_KEYS);
  const applied = !isRunning && !isError && !isDenied;

  // What the *input* carries: an edit names the text it replaces, so both sides
  // are there and the change renders as a diff; a write sends only what the
  // file will contain, so its content stands alone rather than as an
  // all-addition diff against a "before" the input never sent.
  //
  // The result carries more than the input does. Every file tool returns
  // `diff: { filePath, oldContent, newContent, isNewFile }` on `tool_result`
  // (`assistant/src/tools/filesystem/write.ts`, `edit.ts`, and their host
  // twins), which is a whole-file before and after for both tools. The client
  // drops it on the floor today, and it is not persisted on the conversation
  // message, so a reopened conversation would have nothing. Reading it is
  // LUM-3403, and this is the one place that would change.
  const hasBefore =
    "old_string" in detail.input || "new_string" in detail.input;

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
      {hasBefore ? (
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
