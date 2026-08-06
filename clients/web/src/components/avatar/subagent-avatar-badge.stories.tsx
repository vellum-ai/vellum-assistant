/**
 * Storybook harness for `SubagentAvatarBadge`.
 *
 * The badge reads its status from the subagent store rather than from props,
 * so the stories seed that store instead of passing args. No theme decorator:
 * the toolbar switcher and the a11y addon already cover every theme.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { SubagentAvatarBadge } from "@/components/avatar/subagent-avatar-badge";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import {
  SubagentStatusSchema,
  type SubagentStatus,
} from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

const SPAWNED_AT = 1_717_000_000_000;

function storyId(status: SubagentStatus): string {
  return `story-subagent-${status}`;
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

/**
 * How many `EveryStatusRow` instances are on screen. The docs page renders the
 * primary story twice, once under `Primary` and again under `Stories`, so the
 * seed is shared and only the last unmount may clear it.
 */
let mountedRows = 0;

/**
 * Seeds one entry per status on mount and removes exactly those ids on
 * unmount. Seeding belongs to the story's own lifecycle rather than a shared
 * `beforeEach` because the project renders `autodocs`, which mounts every
 * story in this file at once: a teardown that reset the whole store would
 * blank the badges of whichever stories were still on screen.
 *
 * The removal is not optional. The seeded entries carry no
 * `parentConversationId`, and `useActiveSubagentIds` deliberately treats those
 * as visible in every conversation, so any that outlived this story would make
 * unrelated stories render activity affordances they do not expect. An entry
 * with no parent message and no tool-use id sits only in `byId` and
 * `orderedIds`, so those two are the whole cleanup.
 *
 * The ids stay fixed rather than per mount because `SubagentAvatarChip` hashes
 * the subagent id to pick the creature's shape, eyes, and colour. A unique id
 * per mount would draw a different avatar on every reload and let the docs
 * page's two copies disagree, so the shared seed is refcounted instead.
 */
function EveryStatusRow() {
  useEffect(() => {
    mountedRows += 1;
    const { spawnSubagent } = useSubagentStore.getState();
    for (const status of SubagentStatusSchema.options) {
      spawnSubagent({
        subagentId: storyId(status),
        label: "Research Agent",
        objective: "Find the answer",
        timestamp: SPAWNED_AT,
        status,
      });
    }

    return () => {
      mountedRows -= 1;
      if (mountedRows > 0) {
        return;
      }
      const seeded = new Set(SubagentStatusSchema.options.map(storyId));
      useSubagentStore.setState((state) => ({
        byId: Object.fromEntries(
          Object.entries(state.byId).filter(([id]) => !seeded.has(id)),
        ),
        orderedIds: state.orderedIds.filter((id) => !seeded.has(id)),
      }));
    };
  }, []);

  return (
    <div className="flex flex-wrap items-start gap-1">
      {SubagentStatusSchema.options.map((status) => (
        <BadgeSample key={status} status={status} />
      ))}
    </div>
  );
}

const meta: Meta<typeof SubagentAvatarBadge> = {
  title: "Components/SubagentAvatarBadge",
  component: SubagentAvatarBadge,
  parameters: {
    layout: "padded",
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
  render: () => <EveryStatusRow />,
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
