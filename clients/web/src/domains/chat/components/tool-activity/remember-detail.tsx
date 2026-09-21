/**
 * The body for a `remember` call: the facts it saves, as a list a reader can
 * scan, under a label that says whether they were saved. The generic drawer
 * showed the same facts as a JSON array and the confirmation as a code block.
 *
 * The saved facts come from the call's structured result once it lands, which
 * is the list as the daemon stored it (trimmed, blanks dropped). Until then,
 * and for history recorded before `remember` reported one, they come from the
 * call's input, which is the same list as the model wrote it.
 */

import { Typography } from "@vellumai/design-library";

import { ClampedContent, SectionLabel } from "@/components/detail-primitives";
import { ToolOutputBody } from "@/domains/chat/components/tool-activity/tool-output-body";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { useTranslation } from "@/i18n";

/** The facts a `remember` input carries: one string, or a list of them. */
function inputFacts(content: unknown): string[] {
  const raw = Array.isArray(content) ? content : [content];
  return raw
    .filter((fact): fact is string => typeof fact === "string")
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
  const facts =
    activityMetadata?.remember?.facts ?? inputFacts(detail.input.content);
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
