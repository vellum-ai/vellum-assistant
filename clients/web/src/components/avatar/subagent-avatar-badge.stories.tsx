/**
 * Storybook harness for `SubagentAvatarBadge`.
 *
 * The badge reads its status from the subagent store rather than from props,
 * so the stories seed that store instead of passing args. No theme decorator:
 * the toolbar switcher and the a11y addon already cover every theme.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";

import { SubagentAvatarBadge } from "@/components/avatar/subagent-avatar-badge";
import { useSubagentStore } from "@/domains/chat/subagent-store";
import {
  SubagentStatusSchema,
  type SubagentStatus,
} from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

const SPAWNED_AT = 1_717_000_000_000;

function storyId(prefix: string, status: SubagentStatus): string {
  return `${prefix}-${status}`;
}

/** One badge plus its status name, so the stories read without a legend. */
function BadgeSample({
  prefix,
  status,
}: {
  prefix: string;
  status: SubagentStatus;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <SubagentAvatarBadge subagentId={storyId(prefix, status)} />
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
 * The ids are namespaced per mount rather than per module because the docs
 * page renders the primary story twice, once under `Primary` and again under
 * `Stories`. Two instances sharing one id keyspace would each delete the
 * other's entries on unmount and blank the copy still on screen.
 */
function EveryStatusRow() {
  const [prefix] = useState(
    () => `story-subagent-${Math.random().toString(36).slice(2)}`,
  );

  useEffect(() => {
    const { spawnSubagent } = useSubagentStore.getState();
    for (const status of SubagentStatusSchema.options) {
      spawnSubagent({
        subagentId: storyId(prefix, status),
        label: "Research Agent",
        objective: "Find the answer",
        timestamp: SPAWNED_AT,
        status,
      });
    }

    return () => {
      const seeded = new Set(
        SubagentStatusSchema.options.map((status) => storyId(prefix, status)),
      );
      useSubagentStore.setState((state) => ({
        byId: Object.fromEntries(
          Object.entries(state.byId).filter(([id]) => !seeded.has(id)),
        ),
        orderedIds: state.orderedIds.filter((id) => !seeded.has(id)),
      }));
    };
  }, [prefix]);

  return (
    <div className="flex flex-wrap items-start gap-1">
      {SubagentStatusSchema.options.map((status) => (
        <BadgeSample key={status} prefix={prefix} status={status} />
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
