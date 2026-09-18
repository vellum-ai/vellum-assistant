/**
 * The body of an Output section: the sentence that says a call did not run when
 * it was refused, else the text when there is some, else the sentence that says
 * why there is not.
 *
 * A refused call's result is the daemon's instruction to the model ("Do NOT
 * retry this tool call..."), never output for the reader, so the refusal wins
 * over any text that arrives with it.
 *
 * Shared by the generic path in `ToolDetailBody` and by every renderer that
 * owns its own output, because otherwise each one re-derives "denied vs empty
 * vs still running" and they drift. A renderer that skipped the denied case
 * would tell a user their declined call returned nothing.
 */

import { Typography } from "@vellumai/design-library";

import { CodeBlock } from "@/components/detail-primitives";
import { useTranslation } from "@/i18n";

export function ToolOutputBody({
  text,
  isDenied,
  isRunning,
  isError,
}: {
  /** The result, or the streamed tail while one is still arriving. */
  text: string;
  isDenied: boolean;
  isRunning: boolean;
  isError: boolean;
}) {
  const { t } = useTranslation("chat");
  if (text && !isDenied) {
    return (
      <CodeBlock
        text={text}
        tone={isError ? "error" : "default"}
        label={t("toolDetailPanel.output")}
      />
    );
  }
  return (
    <Typography
      variant="body-small-default"
      as="p"
      className="text-[var(--content-tertiary)]"
      data-testid="tool-output-notice"
    >
      {isDenied
        ? t("toolDetailPanel.denied")
        : isRunning
          ? t("toolDetailPanel.running")
          : t("toolDetailPanel.emptyOutput")}
    </Typography>
  );
}
