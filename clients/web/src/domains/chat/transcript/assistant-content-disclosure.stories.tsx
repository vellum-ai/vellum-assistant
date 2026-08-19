import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { MultiActivityGroup } from "@/domains/chat/components/multi-activity-group/multi-activity-group";
import { SingleActivity } from "@/domains/chat/components/single-activity/single-activity";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

import {
  AssistantContentDisclosure,
  type AssistantContentDisclosureItem,
} from "./assistant-content-disclosure";

/**
 * Build a realistic completed {@link ChatMessageToolCall} with a 2s window so
 * durations resolve in the steps panel.
 */
function makeToolCall(
  overrides: Partial<ChatMessageToolCall> = {},
): ChatMessageToolCall {
  const startedAt = 1_717_000_000_000;
  return {
    id: `tc-${overrides.name ?? "bash"}-${startedAt}`,
    name: "bash",
    input: { command: "date", activity: "Checking the current time" },
    riskLevel: "low",
    startedAt,
    completedAt: startedAt + 2_000,
    ...overrides,
  };
}

const REASONING =
  "The user wants five agents on the same prompt. I'll spawn them in " +
  "parallel rather than in sequence so the whole sweep finishes in one " +
  "round trip, then collect the transcripts.";

/**
 * Collapsed prose, styled the way `TranscriptMessageBody` renders a text group
 * inside the disclosure (`COLLAPSED_MARKDOWN_CLASS`): down at the size of the
 * activity rows around it and in the secondary tone, so the revealed run reads
 * as context rather than a second answer.
 */
function CollapsedProse({ children }: { children: string }) {
  return (
    <div className="w-full break-words text-[13px] leading-[20px] text-[var(--content-secondary)]">
      {children}
    </div>
  );
}

/**
 * The "Earlier activity" disclosure that collapses the intermediate work of a
 * settled assistant response. Stories render it in the same column geometry as
 * the transcript (`items-start`, `gap-2`) so the timeline gutter lines up the
 * way it does in chat.
 */
const meta: Meta<typeof AssistantContentDisclosure> = {
  title: "Chat/AssistantContentDisclosure",
  component: AssistantContentDisclosure,
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="flex w-full max-w-[640px] flex-col items-start gap-2">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof AssistantContentDisclosure>;

/** Opens the disclosure so the story lands on the revealed run. */
const openDisclosure: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const trigger = canvas.getByRole("button", { name: "Earlier activity" });
  await userEvent.click(trigger);
};

const MIXED_RUN: AssistantContentDisclosureItem[] = [
  {
    key: "prose",
    node: (
      <CollapsedProse>
        on it. i&apos;ll spin up five parallel agents with a simple test prompt.
      </CollapsedProse>
    ),
  },
  {
    key: "thinking",
    iconName: "brain",
    node: <SingleActivity variant="thinking" content={REASONING} />,
  },
  {
    key: "multi",
    iconName: "terminal",
    node: (
      <div className="w-full">
        <MultiActivityGroup
          toolCalls={[
            makeToolCall({
              id: "tc-spawn",
              input: {
                command: "agents spawn --count 5",
                activity: "Spawning five agents",
              },
            }),
            makeToolCall({
              id: "tc-collect",
              input: {
                command: "agents collect",
                activity: "Collecting transcripts",
              },
            }),
          ]}
        />
      </div>
    ),
  },
  {
    key: "tool",
    iconName: "file",
    node: (
      <SingleActivity
        variant="tool"
        toolCall={makeToolCall({
          id: "tc-read",
          name: "read_file",
          input: { path: "results.md", activity: "Reading results.md" },
        })}
      />
    ),
  },
];

/**
 * Settled and closed — the whole run sits behind one trigger styled as another
 * inline activity link, so the response reads as its final answer plus a single
 * line of chrome.
 */
export const Collapsed: Story = {
  args: {
    items: MIXED_RUN,
  },
};

/**
 * Open — each collapsed group takes a glyph in the timeline gutter (from the
 * same `ICON_MAP` the steps panel reads), with a connector segment running
 * between consecutive glyphs. Collapsed prose renders in the muted content
 * tone; the rows' labels sit indented under the trigger's text.
 */
export const Expanded: Story = {
  args: {
    items: MIXED_RUN,
  },
  play: openDisclosure,
};

/**
 * The case the gutter exists for: a lone thinking row directly under the
 * trigger. Flush against it, the trigger's trailing chevron and the row's own
 * trailing "opens the drawer" chevron read as the same control.
 */
export const ThinkingRunOnly: Story = {
  args: {
    items: [
      {
        key: "thinking",
        iconName: "brain",
        node: <SingleActivity variant="thinking" content={REASONING} />,
      },
      {
        key: "prose",
        node: (
          <CollapsedProse>
            on it. i&apos;ll spin up five parallel agents with a simple test
            prompt.
          </CollapsedProse>
        ),
      },
    ],
  },
  play: openDisclosure,
};

/**
 * Streaming — the trigger is hidden and the content is pinned open, because
 * nothing has been collapsed yet: this is the live turn's own work, which stays
 * flush with the response. The timeline arrives with the trigger when the turn
 * settles, under cover of the collapse animation.
 */
export const Streaming: Story = {
  args: {
    isStreaming: true,
    items: MIXED_RUN,
  },
};
