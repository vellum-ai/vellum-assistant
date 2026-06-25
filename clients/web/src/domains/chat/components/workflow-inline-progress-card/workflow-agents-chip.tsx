/**
 * Purely presentational agent-count chip for the workflow inline card.
 *
 * Renders a rounded surface-overlay pill with an overlapping stack of
 * decorative subagent avatars followed by the formatted count. The count
 * string and avatar seeds are supplied by the caller; the chip holds no
 * workflow state of its own.
 */

import { Typography } from "@vellumai/design-library";

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";

export interface WorkflowAgentsChipProps {
  /** Already-formatted count, e.g. "3 agents". */
  countLabel: string;
  /** Decorative avatar seeds (`runId:seq`), one avatar per seed. */
  seeds: string[];
}

export function WorkflowAgentsChip({
  countLabel,
  seeds,
}: WorkflowAgentsChipProps) {
  return (
    <span
      data-testid="workflow-inline-card-agents-chip"
      className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-overlay)] px-1.5 py-1"
    >
      {seeds.length > 0 && (
        // Decorative identicons seeded by `runId:seq` (not real subagent
        // identities), so the stack is aria-hidden and the count text carries
        // the accessible meaning.
        <span aria-hidden className="flex items-center">
          {seeds.map((seed, index) => (
            <SubagentAvatarChip
              key={seed}
              subagentId={seed}
              size={14}
              className={
                index === 0
                  ? undefined
                  : "-ml-1 rounded-full ring-2 ring-[var(--surface-overlay)]"
              }
            />
          ))}
        </span>
      )}

      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)]"
        data-testid="workflow-inline-card-step-count"
      >
        {countLabel}
      </Typography>
    </span>
  );
}
