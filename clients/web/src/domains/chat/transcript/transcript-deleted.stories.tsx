import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

import { Transcript } from "./transcript";
import { message } from "./transcript-story-fixtures";
import { TranscriptStoryFrame } from "./transcript-story-frame";
import type { TranscriptItem } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
//
// A row deleted on its channel after the daemon stored it arrives from the
// wire with its content intact (kept for Inspect) plus `deletedAt`. The
// transcript renders a tombstone in its place, mirroring what the channel
// now shows, whichever role wrote it.
// ---------------------------------------------------------------------------

function deletedRow(
  id: string,
  role: "user" | "assistant",
  text: string,
): TranscriptItem {
  const msg: DisplayMessage = {
    id,
    role,
    ...textBody(text),
    deletedAt: 1725100001000,
  };
  return { kind: "message", key: id, message: msg };
}

const DELETED_ROWS: TranscriptItem[] = [
  message("m1", "user", "Can you post the release summary to the channel?"),
  message(
    "m2",
    "assistant",
    "Posted. Three fixes, one migration, no flag flips.",
  ),
  deletedRow("m3", "assistant", "Posted the summary a second time by mistake."),
  message("m4", "user", "Thanks, and please remove the duplicate."),
  deletedRow("m5", "user", "oops, wrong channel"),
  message("m6", "assistant", "Removed it."),
];

/**
 * Rows deleted on their channel (a Slack or Discord deletion the gateway
 * forwarded) render as a quiet tombstone, for the assistant's own post and
 * for a person's message alike. The row keeps its anchor and its Inspect
 * affordance, so the stored content stays reachable.
 */
const meta: Meta<typeof Transcript> = {
  title: "Chat/TranscriptDeleted",
  component: Transcript,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    conversationId: "demo",
    onSurfaceAction: () => {},
  },
  decorators: [
    (Story) => (
      <TranscriptStoryFrame height={560}>
        <Story />
      </TranscriptStoryFrame>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Transcript>;

/**
 * An exchange with two deletions: the assistant's own post removed from the
 * channel, and a person's message they deleted themselves.
 */
export const DeletedRows: Story = {
  args: { items: DELETED_ROWS },
};
