/**
 * The "what happened" line a tool-specific renderer leads with: the action in
 * past tense, and under it the tool that was actually called.
 *
 * A native rendering shows the content well (a diff, a terminal) but stops
 * naming the act, so a reader loses the thing the generic block was at least
 * explicit about: that a file was edited, by `file_edit`. This keeps both, and
 * keeps them first.
 *
 * The label is `friendlyToolLabel`, the same past-tense copy the step pills and
 * the macOS app use, so a call is described the same way wherever it appears.
 */

import { Bolt } from "lucide-react";

import { Typography } from "@vellumai/design-library";

import {
  extractInputSummary,
  friendlyToolLabel,
} from "@/domains/chat/components/tool-call-chip/utils";
import { deriveStepLabelFromName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";

export function ToolActionHeader({
  toolName,
  input,
  label,
}: {
  toolName: string;
  input: Record<string, unknown>;
  /**
   * Overrides the derived label. For a renderer whose body already shows the
   * target in full, the default would restate it truncated: `bash` would read
   * "Ran `git status --sh…`" directly above the command block.
   */
  label?: string;
}) {
  const summary = extractInputSummary(toolName, input);
  const { iconName } = deriveStepLabelFromName(toolName, input);
  const Glyph = ICON_MAP[iconName] ?? Bolt;

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-overlay)]">
        <Glyph
          aria-hidden
          className="h-4 w-4 text-[var(--content-secondary)]"
        />
      </div>
      <div className="min-w-0">
        <Typography
          variant="body-medium-default"
          as="div"
          className="truncate text-[var(--content-default)]"
        >
          {label ?? friendlyToolLabel(toolName, summary)}
        </Typography>
        <Typography
          variant="body-small-lighter"
          as="div"
          className="mt-0.5 truncate font-mono text-[var(--content-tertiary)]"
        >
          {toolName}
        </Typography>
      </div>
    </div>
  );
}
