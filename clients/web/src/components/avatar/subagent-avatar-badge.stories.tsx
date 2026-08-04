/**
 * Storybook harness for `SubagentAvatarBadge`.
 *
 * The badge reads its status from the subagent store rather than from props,
 * so the stories seed that store instead of passing args. No theme decorator:
 * the toolbar switcher and the a11y addon already cover every theme.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { SubagentAvatarBadge } from "@/components/avatar/subagent-avatar-badge";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import {
  SubagentStatusSchema,
  type SubagentStatus,
} from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

/** Fixed so seeded entries never vary between renders. */
const SPAWNED_AT = 1_717_000_000_000;

function storyId(status: SubagentStatus): string {
  return `story-subagent-${status}`;
}

/**
 * Reset the store, then seed one entry per status. Resetting first is what
 * keeps entries from accumulating as stories re-render or swap.
 */
function seedEveryStatus() {
  const store = useSubagentStore.getState();
  store.reset();
  for (const status of SubagentStatusSchema.options) {
    store.spawnSubagent({
      subagentId: storyId(status),
      label: "Research Agent",
      objective: "Find the answer",
      timestamp: SPAWNED_AT,
    });
    store.changeStatus({ subagentId: storyId(status), status });
  }
}

const meta: Meta<typeof SubagentAvatarBadge> = {
  title: "Components/SubagentAvatarBadge",
  component: SubagentAvatarBadge,
  parameters: {
    layout: "padded",
  },
  beforeEach: () => {
    seedEveryStatus();
  },
};

export default meta;

type Story = StoryObj<typeof SubagentAvatarBadge>;

/**
 * One badge per `SubagentStatus`, driven off the schema so a newly added
 * status shows up here automatically. The row carries the same `gap-1` the
 * collapsed avatar row ships with (`subagent-avatar-row.tsx`).
 */
export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-1">
      {SubagentStatusSchema.options.map((status) => (
        <div key={status} className="flex flex-col items-center gap-1">
          <SubagentAvatarBadge subagentId={storyId(status)} />
          <Typography
            variant="label-small-default"
            className="text-[var(--content-secondary)]"
          >
            {status}
          </Typography>
        </div>
      ))}
    </div>
  ),
};

/**
 * Spawn race: the badge mounts for an id the store has no entry for yet, so
 * the circle renders with no status indicator.
 */
export const SpawnRace: Story = {
  args: {
    subagentId: "not-in-store",
  },
};
