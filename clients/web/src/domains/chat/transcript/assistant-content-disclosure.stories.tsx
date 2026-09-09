import { useEffect, useState } from "react";
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

/**
 * A long run, one row at a time. Rows land every 900ms from this pool until
 * it is spent, the way a turn that reads a dozen files does, so the story
 * shows the crawl filling, hitting its cap, and then pinning to the newest
 * row while the older ones fade out at the top edge.
 */
const CRAWL_POOL: AssistantContentDisclosureItem[] = [
  {
    key: "prose-1",
    node: (
      <CollapsedProse>
        Let me find the feedback first. Most likely it&apos;s comments on the
        Notion doc. Loading the comment-review skill to pull them.
      </CollapsedProse>
    ),
  },
  {
    key: "thinking-1",
    iconName: "brain",
    node: (
      <SingleActivity
        variant="thinking"
        content="No comments on the page-level anchor. They must be attached to individual blocks instead."
      />
    ),
  },
  {
    key: "prose-2",
    node: (
      <CollapsedProse>
        No page-level comments. They&apos;re probably anchored to individual
        blocks, so I&apos;ll sweep all 52 blocks.
      </CollapsedProse>
    ),
  },
  {
    key: "tool-1",
    iconName: "file",
    node: (
      <SingleActivity
        variant="tool"
        toolCall={makeToolCall({
          id: "tc-sweep",
          name: "read_file",
          input: { path: "blocks.json", activity: "Sweeping 52 blocks" },
        })}
      />
    ),
  },
  {
    key: "prose-3",
    node: (
      <CollapsedProse>
        Found 20 comments but the markdown field came back empty. The field
        structure must differ, so I&apos;ll dump one raw comment.
      </CollapsedProse>
    ),
  },
  {
    key: "thinking-2",
    iconName: "brain",
    node: (
      <SingleActivity
        variant="thinking"
        content="The comment markdown fields printed empty. The body is probably under rich_text."
      />
    ),
  },
  {
    key: "prose-4",
    node: (
      <CollapsedProse>
        Comments are in rich_text, authored by Alice. Re-running the sweep
        with proper extraction, ordered by time.
      </CollapsedProse>
    ),
  },
  {
    key: "multi-1",
    iconName: "terminal",
    node: (
      <div className="w-full">
        <MultiActivityGroup
          toolCalls={[
            makeToolCall({
              id: "tc-extract",
              input: {
                command: "notion comments --all",
                activity: "Extracting 20 comments",
              },
            }),
            makeToolCall({
              id: "tc-sort",
              input: { command: "sort -k time", activity: "Ordering by time" },
            }),
          ]}
        />
      </div>
    ),
  },
  {
    key: "prose-5",
    node: (
      <CollapsedProse>
        All 20 comments extracted. Clear split: durable plan-writing rules for
        the skill, and specific rewrites for the Interactive Tools doc. I need
        three more inputs: the original customer message, the truth about
        ui_show persistence, and per-tool token estimates.
      </CollapsedProse>
    ),
  },
  {
    key: "thinking-3",
    iconName: "brain",
    node: (
      <SingleActivity
        variant="thinking"
        content="Case found: case-123, a Discord customer. Now the original message."
      />
    ),
  },
  {
    key: "prose-6",
    node: (
      <CollapsedProse>
        Case found. Now the original customer message. Let me get the full case
        output and check for notes or the linked activity.
      </CollapsedProse>
    ),
  },
  {
    key: "tool-2",
    iconName: "file",
    node: (
      <SingleActivity
        variant="tool"
        toolCall={makeToolCall({
          id: "tc-case",
          name: "read_file",
          input: { path: "case-123.md", activity: "Reading the case record" },
        })}
      />
    ),
  },
];

const CRAWL_ROW_INTERVAL_MS = 900;

/** Feeds `CRAWL_POOL` into a streaming disclosure one row at a time. */
function StreamingCrawlHarness() {
  const [count, setCount] = useState(2);
  useEffect(() => {
    if (count >= CRAWL_POOL.length) {
      return;
    }
    const timer = setTimeout(
      () => setCount((current) => current + 1),
      CRAWL_ROW_INTERVAL_MS,
    );
    return () => clearTimeout(timer);
  }, [count]);
  return (
    <AssistantContentDisclosure
      isStreaming
      items={CRAWL_POOL.slice(0, count)}
    />
  );
}

/**
 * Streaming, long enough to overflow the cap. The run holds at its capped
 * height with the newest row pinned to the bottom edge and older rows fading
 * out at the top. Drag up inside the run to read an earlier row; the crawl
 * stops following until you scroll back to the bottom.
 */
export const StreamingCrawl: Story = {
  render: () => <StreamingCrawlHarness />,
};

/**
 * The same crawl at phone width, where the cap is shorter so the run leaves
 * room for the composer and the reply below it.
 */
export const StreamingCrawlMobile: Story = {
  render: () => <StreamingCrawlHarness />,
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
