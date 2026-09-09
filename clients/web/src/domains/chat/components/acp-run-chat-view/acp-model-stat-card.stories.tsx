import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { screen, userEvent } from "storybook/test";

import { Toaster } from "@vellumai/design-library";

import type { AcpModelOption, AcpRunEntry } from "@/domains/chat/acp-run-store";
import { ApiError } from "@/utils/api-errors";

import { AcpModelStatCard } from "./acp-model-stat-card";

/**
 * The option set as an ACP adapter reports it: a leading ungrouped row, then
 * two named groups. `groupOptions` splits on each change of `group`, so this
 * is the shape that exercises both a heading and the rows above the first one.
 */
const MODEL_OPTIONS: AcpModelOption[] = [
  {
    value: "default",
    label: "Default",
    description: "Whatever the agent picks",
  },
  {
    value: "sonnet",
    label: "Sonnet",
    description: "Fast, for most turns",
    group: "Claude",
  },
  {
    value: "opus",
    label: "Opus",
    description: "Most capable",
    group: "Claude",
  },
  { value: "haiku", label: "Haiku", description: "Fastest", group: "Claude" },
  { value: "fable", label: "Fable", group: "Claude" },
  {
    value: "opusplan",
    label: "Opus plan mode",
    description: "Opus to plan, Sonnet to execute",
    group: "Mixed",
  },
];

const RUNNING_ENTRY: AcpRunEntry = {
  acpSessionId: "acp-story",
  agent: "claude",
  parentConversationId: "conv-1",
  task: "Review IBM's Q2 2026 results.",
  status: "running",
  startedAt: 0,
  usedTokens: 61_500,
  contextSize: 200_000,
  events: [],
  model: "opus",
  availableModels: MODEL_OPTIONS,
};

/** The answer the daemon would give, for the stories that never take a choice. */
const settledSwitch = () =>
  Promise.resolve({ model: "haiku", availableModels: MODEL_OPTIONS });

/** A switch that never answers, which holds the pending state still. */
const neverSettles = () => new Promise<never>(() => {});

/** A 409: the adapter dropped its model selector mid-run. */
const rejectedSwitch = () =>
  Promise.reject(
    new ApiError(409, "This session no longer offers a model selector."),
  );

/** Pick a model from the open surface, which is what starts a switch. */
async function chooseHaiku(): Promise<void> {
  await userEvent.click(await screen.findByRole("menuitem", { name: /Haiku/ }));
}

function TileFrame({ children }: { children: ReactNode }) {
  return <div style={{ maxWidth: 400, padding: 24 }}>{children}</div>;
}

const meta: Meta<typeof AcpModelStatCard> = {
  title: "Chat/AcpModelStatCard",
  component: AcpModelStatCard,
  args: {
    entry: RUNNING_ENTRY,
    onSwitchModel: settledSwitch,
  },
  decorators: [
    (Story) => (
      <TileFrame>
        <Story />
      </TileFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AcpModelStatCard>;

/**
 * The menu the tile opens, held open by `defaultOpen`.
 *
 * The selected row carries the check and `aria-current`, the group headings
 * are the adapter's own, and the closing line says a choice lands on the next
 * turn rather than the one already streaming.
 */
export const ModelMenuOpen: Story = {
  args: { defaultOpen: true },
};

/**
 * A switch in flight. The tile names the model being moved to, dims it, and
 * refuses a second choice through `aria-disabled` rather than the native
 * attribute, so the focus the closing menu returns still lands somewhere.
 *
 * The run store stays on the old value: it is written from the daemon's
 * answer, so a snapshot fetched mid-switch cannot roll the tile back.
 */
export const ModelSwitchPending: Story = {
  args: { defaultOpen: true, onSwitchModel: neverSettles },
  play: async () => {
    await chooseHaiku();
    await screen.findByRole("button", { name: "Model: Haiku. Change model" });
  },
};

/**
 * A switch the daemon refused. A 400 is the adapter's verdict on the value and
 * a 409 says it no longer offers a choice at all; both carry a message written
 * for the user, so it is shown verbatim instead of generic retry copy.
 *
 * The rejection reaches the user as a toast rather than as tile state, so the
 * story mounts a `Toaster` and the toast dismisses itself on its own timer.
 * The tile drops back to the model the run is still on.
 */
export const ModelSwitchRejected: Story = {
  args: { defaultOpen: true, onSwitchModel: rejectedSwitch },
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  // The play stops at the choice. The toast runs on its own dismiss timer, so
  // waiting for it here would be a race the story could lose.
  play: chooseHaiku,
};

/**
 * A terminal run has nothing left to switch, so the tile is the plain metric
 * card: the id the run finished on, and no trigger.
 */
export const Terminal: Story = {
  args: {
    entry: {
      ...RUNNING_ENTRY,
      status: "completed",
      completedAt: 1,
      model: "claude-opus-4-5-20260301",
      availableModels: undefined,
    },
  },
};
