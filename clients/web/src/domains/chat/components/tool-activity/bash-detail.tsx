/**
 * PROPOSAL, not registered. See `tool-detail-proposals.stories.tsx`.
 *
 * `bash` is the most-called tool, and the generic block shows its command as a
 * quoted value inside a JSON object, beside an `activity` sentence the header
 * is already showing. This gives the command and its output the shape they
 * have in a terminal: the command on a prompt line, the output beneath it, one
 * surface rather than two labelled blocks.
 *
 * No terminal emulator and no ANSI parsing: escape sequences appear in about
 * one in a thousand bash results, so a monospace block with preserved
 * whitespace is the whole of what "reads like a terminal" needs here.
 */

import { Typography } from "@vellumai/design-library";

import { ClampedContent, CopyButton } from "@/components/detail-primitives";
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
    <div className="relative overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)]">
      <div className="flex gap-2 px-3 pt-3 pb-2 font-mono text-xs">
        {/* The prompt marker is the one piece of terminal furniture worth
            keeping: it is what separates the command from its output without
            spending a section label on each. */}
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

      <div className="px-3 pb-3">
        {body ? (
          <ClampedContent length={body.length}>
            <pre
              className={`font-mono text-xs break-words whitespace-pre-wrap ${
                isError
                  ? "text-[var(--system-negative-strong)]"
                  : "text-[var(--content-secondary)]"
              }`}
            >
              {body}
            </pre>
          </ClampedContent>
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

      {command && <CopyButton text={command} />}
    </div>
  );
}
