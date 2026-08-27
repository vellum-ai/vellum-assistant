import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";

import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";
import {
  SLACK_MESSAGE_ENTRY,
  SLACK_SPARSE_ENTRIES,
  SLACK_THREAD_ENTRIES,
} from "@/domains/chat/channel-sidecar/channel-sidecar-story-fixtures";
import type { ChannelTranscriptEntry } from "@/domains/chat/channel-sidecar/channel-sidecar-transcript";

import { ChannelTranscriptEntryRow } from "./channel-transcript-entry-row";

/**
 * A row of the read-only channel drawer, framed the way the drawer frames it.
 * Message rows offer "Reference in Vellum"; reaction rows are read-only. The
 * whole panel has its own stories (`Chat/ChannelTranscriptPanel`); these
 * cover the row itself.
 *
 * The "Reference in Vellum" control uses the shared reveal treatment, so on a
 * pointer device it appears on hover and on keyboard focus, and on a device
 * that reports `hover: none` it is simply always visible. Tab through a story
 * to see the focus path.
 */
const meta: Meta<typeof ChannelTranscriptEntryRow> = {
  title: "Chat/ChannelTranscriptEntryRow",
  component: ChannelTranscriptEntryRow,
  parameters: { layout: "fullscreen" },
  args: {
    entry: SLACK_MESSAGE_ENTRY,
    channelLabel: "Slack",
    assistantName: "Vellum",
    isReferenced: false,
  },
  argTypes: {
    onToggleReference: { control: false },
  },
  decorators: [
    (Story) => (
      <DetailPanelStoryFrame>
        <div className="flex h-full flex-col gap-1 overflow-y-auto rounded-xl bg-[var(--surface-lift)] p-4">
          <Story />
        </div>
      </DetailPanelStoryFrame>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ChannelTranscriptEntryRow>;

/**
 * One ordinary row. `isReferenced` is the row's controlled state
 * (`isReferenced` + `onToggleReference`), so the arg owns it and the toggle
 * writes it back through `useArgs`: clicking the control flips the pressed
 * state on the canvas and in the Controls panel alike.
 */
export const Default: Story = {
  render: function Render(args) {
    const [{ isReferenced }, updateArgs] = useArgs<{ isReferenced: boolean }>();
    return (
      <ChannelTranscriptEntryRow
        {...args}
        isReferenced={isReferenced}
        onToggleReference={() => updateArgs({ isReferenced: !isReferenced })}
      />
    );
  },
};

/** The staged row, drawn as pressed while it sits on the composer. */
export const Referenced: Story = {
  ...Default,
  args: { isReferenced: true },
};

/**
 * Gallery helper owning the staged row locally. Local state rather than
 * `useArgs` because the galleries render several row instances against the
 * one-slot staging semantics (picking a row un-stages the previous one), and
 * a single component's args cannot address which of many rows is staged.
 */
function Rows({ entries }: { entries: ChannelTranscriptEntry[] }) {
  const [referencedId, setReferencedId] = useState<string | null>(null);
  return (
    <>
      {entries.map((entry) => (
        <ChannelTranscriptEntryRow
          key={entry.id}
          entry={entry}
          channelLabel="Slack"
          assistantName="Vellum"
          isReferenced={referencedId === entry.id}
          onToggleReference={(picked) =>
            setReferencedId((current) =>
              current === picked.id ? null : picked.id,
            )
          }
        />
      ))}
    </>
  );
}

/**
 * An ordinary thread including an assistant reply and a reaction event; pick
 * a message row to stage it and see the previous pick clear. The reaction row
 * offers no reference control.
 */
export const Thread: Story = {
  parameters: { controls: { disable: true } },
  render: () => <Rows entries={SLACK_THREAD_ENTRIES} />,
};

/**
 * What the row degrades to when the channel reports less (no sender, no
 * timestamp), plus a long pasted body rendered in full. Each is a shape Slack
 * can genuinely produce, not an error.
 */
export const SparseMetadata: Story = {
  parameters: { controls: { disable: true } },
  render: () => <Rows entries={SLACK_SPARSE_ENTRIES} />,
};
