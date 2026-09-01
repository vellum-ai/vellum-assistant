/**
 * The progress card, in the states the rail actually puts it in.
 *
 * The trigger self-sources: it resolves its own plan from the transcript via
 * `useLatestTaskProgress`, and the panel owns its own open state. So the
 * stories seed the transcript rather than passing props, which is what keeps
 * them honest: a story renders the same way the chat does.
 *
 * The chat-session store is a global singleton, so every story seeds it on
 * mount and clears it after; without that, one story's plan leaks into
 * whichever renders next.
 *
 * The panel is a popover, so these stories show the TRIGGER. Click it to see
 * the plan.
 *
 * The control is not standing chrome: it is present only while a plan is
 * running, or while a finished plan has not been acknowledged, and it slides in
 * and out accordingly. The acknowledgement store is in-memory, so each story
 * starts unacknowledged and a finished plan still shows here. Open it and
 * close it to watch it leave.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { randomCharacterTraits } from "@/utils/avatar-random";

import { ProgressCard } from "@/domains/chat/components/progress-card";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";

const ASSISTANT_ID = "asst-story";
const T0 = 1_700_000_000_000;

interface Step {
  label: string;
  status?: string;
  detail?: string;
}

/** A message carrying one `task_progress` card surface, as the wire ships it. */
function seedPlan(
  title: string,
  status: string | undefined,
  steps: Step[],
): void {
  useChatSessionStore.setState({
    snapshot: {
      messages: [
        {
          id: "m-plan",
          role: "assistant",
          timestamp: T0,
          surfaces: [
            {
              surfaceId: "sfc-plan",
              type: "card",
              data: {
                template: "task_progress",
                templateData: { title, status, steps },
              },
            },
          ],
        },
      ],
    },
    optimisticSends: [],
    dismissedSurfaceIds: new Set<string>(),
  } as never);
}

/**
 * A random character avatar, so the entrance plays its takeover: the wash needs
 * an accent color and the eyes need an eye style, and an unseeded assistant has
 * neither. Random rather than fixed on purpose: the treatment has to hold up
 * across the whole palette, and rerunning the story is the cheapest way to see
 * that.
 *
 * Returns the accent so the harness can set `--avatar-accent` on the element:
 * that is the property the wash reads, and the app publishes it from
 * `useAvatarAccentVar`, which no story mounts.
 */
function seedAvatar(queryClient: QueryClient): string | null {
  useResolvedAssistantsStore.setState({
    activeAssistantId: ASSISTANT_ID,
  } as never);
  const traits = randomCharacterTraits(BUNDLED_COMPONENTS);
  queryClient.setQueryData(avatarQueryKey(ASSISTANT_ID), {
    components: BUNDLED_COMPONENTS,
    traits,
    customImageUrl: null,
  });
  return (
    BUNDLED_COMPONENTS.colors.find((c) => c.id === traits.color)?.hex ?? null
  );
}

function clearPlan(): void {
  useChatSessionStore.setState({
    snapshot: { messages: [] },
    optimisticSends: [],
    dismissedSurfaceIds: new Set<string>(),
  } as never);
}

/**
 * Seeds the transcript and the rail's open state before first paint, and clears
 * the transcript on the way out.
 */
function Harness({
  plan,
}: {
  /** `null` renders the no-plan empty state behind the trigger. */
  plan: { title: string; status?: string; steps: Step[] } | null;
}) {
  const queryClient = useQueryClient();
  const [accent, setAccent] = useState<string | null>(null);
  const [seeded] = useState(() => {
    setAccent(seedAvatar(queryClient));
    if (plan) {
      seedPlan(plan.title, plan.status, plan.steps);
    } else {
      clearPlan();
    }
    return true;
  });
  void seeded;

  useEffect(() => clearPlan, []);

  // `items-end` mirrors the cluster's right alignment on desktop, so the
  // trigger sits here the way it sits in the app.
  return (
    <div
      className="flex w-[300px] flex-col items-end"
      style={(accent ? { "--avatar-accent": accent } : {}) as CSSProperties}
    >
      <ProgressCard />
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: "Chat/ProgressCard",
  component: Harness,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof Harness>;

const RUNNING_PLAN = {
  title: "Building your toggle",
  status: "in_progress",
  steps: [
    {
      label: "Scope the request",
      status: "completed",
      detail: "Confirmed target + constraints",
    },
    {
      label: "Pull the data",
      status: "completed",
      detail: "3 sources fetched",
    },
    { label: "Build the artifact", status: "in_progress" },
    { label: "Hand over" },
  ],
};

/**
 * **Loading.** A plan still in progress: the whole trigger shimmers, since there
 * is no label to sweep. The sweep is phase-locked to the document timeline, so
 * it moves in step with every other shimmering surface on screen. Click the
 * trigger to open the plan.
 */
export const Loading: Story = {
  args: { plan: RUNNING_PLAN },
};

/**
 * A finished plan, not yet acknowledged: the trigger is at rest but still
 * present, because the outcome is exactly what is worth reading and vanishing
 * on completion would take it away at that moment. Open and close it to
 * acknowledge, and it slides out.
 */
export const CompleteUnacknowledged: Story = {
  args: { plan: { ...RUNNING_PLAN, status: "completed" } },
};

/**
 * A long plan. The trigger is unchanged; the panel behind it caps its height
 * and scrolls, so the plan can never outgrow the viewport.
 */
export const LongPlan: Story = {
  args: {
    plan: {
      title: "Migrating the ingestion pipeline",
      status: "in_progress",
      steps: Array.from({ length: 14 }, (_, i) => ({
        label: `Step ${i + 1}: migrate a batch of records`,
        status: i < 5 ? "completed" : i === 5 ? "in_progress" : undefined,
        detail: i < 5 ? "Done" : undefined,
      })),
    },
  },
};

/**
 * No plan in the thread: nothing renders at all. The control has nothing to
 * report, so it stays away rather than sitting there empty. Its presence is
 * what tells you there is something to read.
 */
export const NoPlan: Story = {
  args: { plan: null },
};
