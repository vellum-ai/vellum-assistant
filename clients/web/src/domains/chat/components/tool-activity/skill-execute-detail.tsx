/**
 * Purpose-built activity UI for a `skill_execute` call (LUM-2999).
 *
 * `skill_execute` is an envelope — `{ tool, input, activity }` — so the generic
 * JSON dump buried the thing the reader actually cares about (which tool ran,
 * with which parameters) one level down, wrapped in machine plumbing. This
 * renderer unwraps it: the inner tool leads, the activity sentence explains it,
 * and the inner parameters render as a labelled list instead of JSON.
 */

import { Plug } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { CodeBlock, SectionLabel } from "@/components/detail-primitives";
import { DetailDisclosure } from "@/domains/chat/components/tool-activity/detail-disclosure";
import { friendlyName } from "@/domains/chat/components/tool-call-chip/utils";
import { parseSkillExecuteActivity } from "@/domains/chat/utils/skill-activity";
import type { SkillExecuteParam } from "@/domains/chat/utils/skill-activity";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { useTranslation } from "@/i18n";

/**
 * Scalar strings longer than this render in their own wrapped block rather
 * than inline beside the key, so a long prompt or file body stays readable
 * instead of squeezing the label column.
 */
const INLINE_SCALAR_MAX_CHARS = 48;

function ParamRow({ param }: { param: SkillExecuteParam }) {
  const inline =
    param.scalar !== null &&
    param.scalar.length <= INLINE_SCALAR_MAX_CHARS &&
    !param.scalar.includes("\n");

  return (
    <div
      className={
        inline ? "flex items-baseline justify-between gap-4" : "flex flex-col"
      }
    >
      {/* `leading-5` is deliberate: the `body-small-default` token ships
          `line-height: 1`, which clips the descenders on keys like `template`
          and `config`. */}
      <Typography
        variant="body-small-default"
        as="div"
        className="shrink-0 font-mono leading-5 text-[var(--content-tertiary)]"
      >
        {param.key}
      </Typography>
      {param.scalar !== null ? (
        <Typography
          variant="body-medium-default"
          as="div"
          className={
            inline
              ? "min-w-0 truncate text-right text-[var(--content-default)]"
              : "mt-1.5 whitespace-pre-wrap break-words rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3 leading-relaxed text-[var(--content-default)]"
          }
        >
          {param.scalar}
        </Typography>
      ) : (
        <div className="mt-1.5">
          <CodeBlock text={param.json ?? ""} />
        </div>
      )}
    </div>
  );
}

export function SkillExecuteDetail({
  detail,
  isRunning,
}: ToolActivityRendererProps) {
  const { t } = useTranslation("chat");
  const { innerToolName, activity, params } = parseSkillExecuteActivity(
    detail.input,
  );

  const heading = innerToolName ? friendlyName(innerToolName) : "Skill tool";
  const subtitle = activity || detail.activity;

  return (
    <div className="flex flex-col gap-5">
      {/* Inner tool identity — the tool that actually ran, not the envelope. */}
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-overlay)]">
          <Plug className="h-4 w-4 text-[var(--content-secondary)]" />
        </div>
        <div className="min-w-0">
          <Typography
            variant="body-medium-default"
            as="div"
            className="truncate text-[var(--content-default)]"
          >
            {heading}
          </Typography>
          {innerToolName && (
            <Typography
              variant="body-small-lighter"
              as="div"
              className="mt-0.5 truncate font-mono text-[var(--content-tertiary)]"
            >
              {innerToolName}
              {isRunning ? t("skillExecuteDetail.runningSuffix") : ""}
            </Typography>
          )}
        </div>
      </div>

      {subtitle && (
        <Typography
          variant="body-small-lighter"
          as="p"
          className="text-[var(--content-secondary)]"
        >
          {subtitle}
        </Typography>
      )}

      {params.length > 0 && (
        <div>
          <SectionLabel>{t("skillExecuteDetail.parameters")}</SectionLabel>
          <div className="flex flex-col gap-4 rounded-lg border border-[var(--border-base)] p-4">
            {params.map((param) => (
              <ParamRow key={param.key} param={param} />
            ))}
          </div>
        </div>
      )}

      <DetailDisclosure label={t("skillExecuteDetail.rawInput")}>
        <CodeBlock text={JSON.stringify(detail.input, null, 2)} />
      </DetailDisclosure>
    </div>
  );
}
