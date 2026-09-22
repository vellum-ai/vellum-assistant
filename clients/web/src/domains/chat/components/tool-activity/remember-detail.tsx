/**
 * The body for a `remember` call: the facts it saves, as a list, under a label
 * that says whether they were saved, and why not when they were not.
 *
 * The facts come from the call's structured result when it has one, which is
 * the list as the daemon stored it. Otherwise they come from the call's input,
 * read with the same `RememberInputSchema` the daemon parses it with.
 */

import {
  type RememberInput,
  RememberInputSchema,
} from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

import { ClampedContent, SectionLabel } from "@/components/detail-primitives";
import { ToolOutputBody } from "@/domains/chat/components/tool-activity/tool-output-body";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { useTranslation } from "@/i18n";

/** The facts in a `remember` input, as the model wrote them, blanks dropped. */
function inputFacts(content: RememberInput["content"]): string[] {
  return [content]
    .flat()
    .map((fact) => fact.trim())
    .filter((fact) => fact.length > 0);
}

export function RememberDetail({
  detail,
  result,
  activityMetadata,
  isRunning,
  isError,
  isDenied,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const input = RememberInputSchema.safeParse(detail.input);
  const facts =
    activityMetadata?.remember?.facts ??
    (input.success ? inputFacts(input.data.content) : []);
  const failed = isError || isDenied;
  const label = failed
    ? t("rememberDetail.notSaved")
    : isRunning
      ? t("rememberDetail.saving")
      : t("rememberDetail.saved");

  return (
    <div className="flex flex-col gap-5">
      {facts.length > 0 && (
        <div>
          <SectionLabel>{label}</SectionLabel>
          <ClampedContent label={label}>
            <ul className="flex flex-col gap-3">
              {facts.map((fact, index) => (
                <li key={index}>
                  <Typography
                    variant="body-medium-lighter"
                    as="p"
                    className="whitespace-pre-wrap break-words text-[var(--content-default)]"
                  >
                    {fact}
                  </Typography>
                </li>
              ))}
            </ul>
          </ClampedContent>
        </div>
      )}
      {/* Why nothing was saved. A saved call's result only confirms it, which
          the label above already says. */}
      {failed && (
        <div>
          <SectionLabel>{t("toolDetailPanel.output")}</SectionLabel>
          <ToolOutputBody
            text={typeof result === "string" ? result : ""}
            isDenied={isDenied}
            isRunning={false}
            isError={isError}
          />
        </div>
      )}
    </div>
  );
}
