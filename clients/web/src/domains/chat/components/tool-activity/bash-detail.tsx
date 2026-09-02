/**
 * PROPOSAL, not registered. See `tool-detail-proposals.stories.tsx`.
 *
 * `bash` is the most-called tool, and the generic block shows its command as a
 * quoted value inside a JSON object. This keeps the command and its output as
 * two labelled things, which is what they are, and shows each in the shape it
 * has in a terminal: a prompt line, then what came back.
 *
 * No terminal emulator and no ANSI parsing: escape sequences appear in about
 * one in a thousand bash results, so a monospace block with preserved
 * whitespace is the whole of what "reads like a terminal" needs here.
 */

import { Typography } from "@vellumai/design-library";

import {
  ClampedContent,
  CopyButton,
  SectionLabel,
} from "@/components/detail-primitives";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { useTranslation } from "@/i18n";

export function BashDetail({
  detail,
  result,
  streamedOutput,
  isRunning,
  isError,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const command =
    typeof detail.input.command === "string" ? detail.input.command : "";
  const body =
    typeof result === "string" && result !== ""
      ? result
      : (streamedOutput ?? "");

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionLabel>{t("toolDetailPanel.command")}</SectionLabel>
        <div className="relative rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3">
          <div className="flex gap-2 font-mono text-xs">
            {/* The prompt marker is the one piece of terminal furniture worth
                keeping: it marks the line as something that was run. */}
            <span
              aria-hidden
              className="shrink-0 select-none text-[var(--content-faint)]"
            >
              $
            </span>
            <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-[var(--content-default)]">
              {command}
            </span>
          </div>
          <CopyButton text={command} />
        </div>
      </div>

      <div>
        <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
        {body ? (
          <div className="relative rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3">
            <ClampedContent length={body.length}>
              <pre
                className={`font-mono text-xs break-words whitespace-pre-wrap ${
                  isError
                    ? "text-[var(--system-negative-strong)]"
                    : "text-[var(--content-default)]"
                }`}
              >
                {body}
              </pre>
            </ClampedContent>
            <CopyButton text={body} />
          </div>
        ) : (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-tertiary)]"
          >
            {isRunning
              ? t("toolDetailPanel.running")
              : t("toolDetailPanel.emptyOutput")}
          </Typography>
        )}
      </div>
    </div>
  );
}
