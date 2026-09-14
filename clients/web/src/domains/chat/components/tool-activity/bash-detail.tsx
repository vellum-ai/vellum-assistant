/**
 * `bash` is the most-called tool. This shows its command and its output as the
 * two things they are, rather than as a JSON object quoting one above a block
 * of text.
 *
 * No terminal emulator and no ANSI parsing: escape sequences appear in about
 * one in a thousand bash results, so a monospace block with preserved
 * whitespace is the whole of what a terminal needs here.
 */

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import { ToolOutputBody } from "@/domains/chat/components/tool-activity/tool-output-body";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import {
  COMMAND_KEYS,
  readToolInputString,
} from "@/domains/chat/utils/tool-input";
import { useTranslation } from "@/i18n";

export function BashDetail({
  detail,
  result,
  streamedOutput,
  isRunning,
  isError,
  isDenied,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const command = readToolInputString(detail.input, ...COMMAND_KEYS);
  const body =
    typeof result === "string" && result !== ""
      ? result
      : (streamedOutput ?? "");

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionLabel>{t("toolDetailPanel.command")}</SectionLabel>
        <CodeBlock text={command} />
      </div>

      <div>
        <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
        <ToolOutputBody
          text={body}
          isDenied={isDenied}
          isRunning={isRunning}
          isError={isError}
        />
      </div>
    </div>
  );
}
