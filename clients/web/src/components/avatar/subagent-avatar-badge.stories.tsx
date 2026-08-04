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
 *
 * The seeded entries carry no `parentConversationId`, and `useActiveSubagentIds`
 * deliberately treats those as visible in every conversation, so they have to be
 * torn down after each story or the three active ones leak into unrelated
 * stories and make them render activity affordances they do not expect.
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

/** One badge plus its status name, so the stories read without a legend. */
function BadgeSample({ status }: { status: SubagentStatus }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <SubagentAvatarBadge subagentId={storyId(status)} />
      <Typography
        variant="label-small-default"
        className="text-[var(--content-secondary)]"
      >
        {status}
      </Typography>
    </div>
  );
}

const meta: Meta<typeof SubagentAvatarBadge> = {
  title: "Components/SubagentAvatarBadge",
  component: SubagentAvatarBadge,
  parameters: {
    layout: "padded",
  },
  beforeEach: () => {
    seedEveryStatus();
    return () => {
      useSubagentStore.getState().reset();
    };
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
        <BadgeSample key={status} status={status} />
      ))}
    </div>
  ),
};

/**
 * The three pill fills next to each other: the neutral `--surface-lift` while
 * in flight, `--system-positive-weak` on success, `--system-negative-weak` on
 * failure. Spaced apart so the a11y addon has each tint paired with its glyph
 * colour, which the tightly packed `AllStatuses` row makes hard to compare.
 */
export const TerminalTints: Story = {
  render: () => (
    <div className="flex flex-wrap items-start gap-6">
      {(["running", "completed", "failed"] as const).map((status) => (
        <BadgeSample key={status} status={status} />
      ))}
    </div>
  ),
};

/**
 * Spawn race: the badge mounts for an id the store has no entry for yet, so
 * the pill renders with an empty glyph slot and its neutral fill.
 */
export const SpawnRace: Story = {
  args: {
    subagentId: "not-in-store",
  },
};
