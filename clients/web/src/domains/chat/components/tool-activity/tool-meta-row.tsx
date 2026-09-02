/**
 * PROPOSAL, not registered. See `tool-detail-proposals.stories.tsx`.
 *
 * One line naming which tool ran and how risky it was, replacing the section
 * label plus full-width tone bar the panel spends on risk today, and the
 * title-cased tool name it prints underneath.
 *
 * The panel header already carries the activity sentence the daemon wrote
 * ("Widening the risk level union"), which is the best description of the call
 * we have. This row deliberately does not restate it: it answers the two
 * questions the sentence does not, which tool and how risky, and leaves the
 * body to show the substance.
 *
 * Nothing here is new: the glyph is the `ICON_MAP` entry the timeline pills
 * use, the name is `friendlyName`, and the pill is `RiskBadge`.
 */

import { Bolt } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import { RiskChip } from "@/domains/chat/components/tool-activity/risk-chip";
import { friendlyName } from "@/domains/chat/components/tool-call-chip/utils";
import { deriveStepLabelFromName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";

export function ToolMetaRow({
  toolName,
  input,
  riskLevel,
}: {
  toolName: string;
  input: Record<string, unknown>;
  riskLevel?: string;
}) {
  const { iconName } = deriveStepLabelFromName(toolName, input);
  const Glyph = ICON_MAP[iconName] ?? Bolt;

  return (
    <div className="flex items-center gap-2">
      <Glyph
        aria-hidden
        className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
      />
      <Typography
        variant="body-small-default"
        as="span"
        className="min-w-0 flex-1 truncate text-[var(--content-secondary)]"
      >
        {friendlyName(toolName)}
      </Typography>
      <RiskChip level={riskLevel} />
    </div>
  );
}
