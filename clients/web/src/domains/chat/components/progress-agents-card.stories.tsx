/**
 * The Agents card, in the states the rail puts it in.
 *
 * The trigger resolves its own sessions from the subagent and ACP run stores
 * via `useConversationActivity`, so the stories seed those stores rather than
 * passing rows. They are global singletons, so every story resets them on the
 * way out; without that, one story's agents leak into the next.
 *
 * The panel is a popover, so these stories show the TRIGGER: the stacked agent
 * marks that are its only label. Click it to see the rows.
 *
 * The control is present only while agents are actually WORKING, and slides out
 * once the last one finishes, so the all-finished fixtures render nothing.
 * Finished sessions are still listed inside while it is up; they just do not
 * hold it open on their own.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import { randomCharacterTraits } from "@/utils/avatar-random";

import { ProgressAgentsCard } from "@/domains/chat/components/progress-agents-card";
import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useSubagentStore } from "@/domains/chat/subagent-store";

const ASSISTANT_ID = "asst-story";
const CONVERSATION_ID = "conv-story";
const T0 = 1_700_000_000_000;

/** A finished subagent, with a timeline so its card settles instead of loading. */
function seedFinishedSubagent(id: string, label: string, at: number): void {
  useSubagentStore.getState().spawnSubagent({
    subagentId: id,
    label,
    objective: label,
    status: "completed",
    conversationId: `${id}-child`,
    parentConversationId: CONVERSATION_ID,
    timestamp: at,
  });
  // Without a loaded timeline a finished subagent projects as `loading` (it
  // reports "Loading" rather than claiming 0 steps), which is the wrong card.
  useSubagentStore.getState().loadDetail({
    subagentId: id,
    events: [{ id: `${id}-e1`, type: "text", content: "Done", timestamp: at }],
  });
}

function seedRunningSubagent(id: string, label: string, at: number): void {
  useSubagentStore.getState().spawnSubagent({
    subagentId: id,
    label,
    objective: label,
    status: "running",
    conversationId: `${id}-child`,
    parentConversationId: CONVERSATION_ID,
    timestamp: at,
  });
  useSubagentStore.getState().loadDetail({
    subagentId: id,
    events: [
      { id: `${id}-e1`, type: "text", content: "Working", timestamp: at },
    ],
  });
}

function seedRunningAcp(): void {
  useAcpRunStore.getState().spawnRun({
    acpSessionId: "acp-live",
    agent: "claude",
    parentConversationId: CONVERSATION_ID,
    startedAt: T0,
  });
  useAcpRunStore.getState().receiveEvent({
    acpSessionId: "acp-live",
    event: {
      seq: 1,
      updateType: "tool_call",
      toolCallId: "tc-1",
      toolTitle: "Reading gateway restart logs",
      toolStatus: "in_progress",
    },
  });
}

type Fixture = "completed" | "mixed" | "many" | "running" | "none";

function seed(fixture: Fixture): void {
  if (fixture === "completed") {
    ["test-agent-1", "test-agent-3", "test-agent-2", "test-agent-4"].forEach(
      (label, i) => seedFinishedSubagent(`sa-done-${i}`, label, T0 + i * 100),
    );
  } else if (fixture === "running") {
    seedRunningAcp();
    for (let i = 0; i < 2; i++) {
      seedRunningSubagent(`sa-live-${i}`, `researcher-${i}`, T0 + 10 + i * 10);
    }
  } else if (fixture === "mixed") {
    seedRunningAcp();
    seedFinishedSubagent("sa-done-0", "slack-thread-audit", T0 + 1_000);
  } else if (fixture === "many") {
    seedRunningAcp();
    for (let i = 0; i < 4; i++) {
      seedRunningSubagent(`sa-live-${i}`, `researcher-${i}`, T0 + 10 + i * 10);
    }
    ["gateway-log-sweep", "retry-policy-review", "slack-thread-audit"].forEach(
      (label, i) => seedFinishedSubagent(`sa-done-${i}`, label, T0 + i * 100),
    );
  }
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

function reset(): void {
  useAcpRunStore.getState().reset();
  useSubagentStore.getState().reset();
}

function Harness({ fixture }: { fixture: Fixture }) {
  const queryClient = useQueryClient();
  const [accent, setAccent] = useState<string | null>(null);
  const [seeded] = useState(() => {
    setAccent(seedAvatar(queryClient));
    reset();
    seed(fixture);
    return true;
  });
  void seeded;

  useEffect(() => reset, []);

  // `items-end` mirrors the cluster's right alignment on desktop, so the
  // trigger sits here the way it sits in the app.
  return (
    <div
      className="flex w-[300px] flex-col items-end"
      style={(accent ? { "--avatar-accent": accent } : {}) as CSSProperties}
    >
      <ProgressAgentsCard conversationId={CONVERSATION_ID} />
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: "Chat/ProgressAgentsCard",
  component: Harness,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof Harness>;

/**
 * Four subagents, all finished: nothing renders. There is no live work to
 * report, so the control has left. Its arrival and departure are the signal.
 */
export const AllFinished: Story = {
  args: { fixture: "completed" },
};

/**
 * **Loading.** Everything still running: the whole trigger shimmers, matching
 * the Progress button beside it, and the group leads with its pulsing dots,
 * which is the one thing the marks alone cannot say.
 */
export const Loading: Story = {
  args: { fixture: "running" },
};

/**
 * One running ACP run and one finished subagent. Present and shimmering,
 * because something is still working, with both status groups on the trigger.
 */
export const Mixed: Story = {
  args: { fixture: "mixed" },
};

/**
 * Several of each kind, running and finished. The point is that a status group
 * mixes ACP brand marks and subagent avatars in the SAME stack: the groups are
 * status groups, never per-kind ones.
 */
export const Many: Story = {
  args: { fixture: "many" },
};

/**
 * No sessions at all: nothing renders, the same as the all-finished case.
 */
export const NoAgents: Story = {
  args: { fixture: "none" },
};
