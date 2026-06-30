/**
 * Agent-count chip for the workflow inline card — the workflow kind's custom
 * `renderCount` slot. Renders a rounded `--surface-overlay` pill with an
 * overlapping stack of decorative subagent avatars followed by the formatted
 * count ("N agents").
 *
 * Self-contained: reads the avatar seeds (`useWorkflowAgentAvatarSeeds`) and the
 * formatted count label (`useWorkflowCardData(runId).stepCount`) off the
 * workflow store for `runId`, so the descriptor can wire it with just an id.
 * Renders nothing when the run has no card-worthy state yet, or when the count
 * is "0 …"/"1 …" — a workflow with fewer than two agents doesn't warrant the
 * avatar-stack chip.
 */

import { Typography } from "@vellumai/design-library";

import { SubagentAvatarChip } from "@/components/avatar/subagent-avatar-chip";
import {
  useWorkflowAgentAvatarSeeds,
  useWorkflowCardData,
} from "@/domains/chat/hooks/use-workflow-card-data";

export function WorkflowAgentsChip({ runId }: { runId: string }) {
  const seeds = useWorkflowAgentAvatarSeeds(runId);
  const data = useWorkflowCardData(runId);

  // `stepCount` is the pre-formatted noun string (e.g. "3 agents"). No entry yet
  // → render nothing, matching the inline card's short-circuit.
  if (!data) return null;
  const countLabel = data.stepCount;

  // Hide the chip for 0- or 1-agent workflows: a single-agent (or empty) run
  // doesn't warrant the avatar-stack chip.
  if (countLabel.startsWith("0 ") || countLabel.startsWith("1 ")) return null;

  return (
    <div
      data-testid="workflow-inline-card-agents-chip"
      className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-overlay)] px-1.5 py-1"
    >
      {seeds.length > 0 && (
        // Decorative identicons seeded by `runId:seq` (not real subagent
        // identities), so the stack is aria-hidden and the count text carries
        // the accessible meaning. The wrappers are divs because
        // `SubagentAvatarChip` renders a div, which is invalid inside a span.
        <div aria-hidden className="flex items-center">
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
        </div>
      )}

      <Typography
        variant="body-small-default"
        className="text-[var(--content-secondary)]"
        data-testid="workflow-inline-card-step-count"
      >
        {countLabel}
      </Typography>
    </div>
  );
}
