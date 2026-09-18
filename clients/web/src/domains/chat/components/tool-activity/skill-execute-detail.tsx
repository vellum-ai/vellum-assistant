/**
 * Purpose-built activity UI for a `skill_execute` call (LUM-2999).
 *
 * `skill_execute` is an envelope (`{ tool, input, activity }`), so the generic
 * JSON dump buried the thing the reader actually cares about (which tool ran,
 * with which parameters) one level down, wrapped in machine plumbing. This
 * renderer unwraps it: the inner tool leads, the activity sentence explains it,
 * and the inner parameters render as labelled fields instead of JSON.
 */

import { Plug } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { MachineText } from "@/components/detail-primitives";
import { ToolInputParameters } from "@/domains/chat/components/tool-activity/tool-input-parameters";
import { friendlyName } from "@/domains/chat/components/tool-call-chip/utils";
import { parseSkillExecuteActivity } from "@/domains/chat/utils/skill-activity";
import type { ToolActivityRendererProps } from "@/domains/chat/components/tool-activity/types";
import { useTranslation } from "@/i18n";

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
      {/* Inner tool identity: the tool that actually ran, not the envelope. */}
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
            <MachineText
              as="div"
              tone="muted"
              className="mt-0.5 truncate"
              title={innerToolName}
            >
              {innerToolName}
              {isRunning ? t("skillExecuteDetail.runningSuffix") : ""}
            </MachineText>
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

      <ToolInputParameters params={params} rawInput={detail.input} />
    </div>
  );
}
