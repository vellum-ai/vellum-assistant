/**
 * A Chat Info row: the category header with its exact total and a See All
 * control, over one line of tiles.
 *
 * The row is tile-agnostic, so most of these stories feed it the shipped 64px
 * `MessageAttachmentSquare`. What they document is the fit rule: on a roomy
 * window the line is truncated to the tiles its measured width holds, and on a
 * phone the same width decides a horizontal strip that runs past the screen
 * edge. See All appears whenever the category's total exceeds that line, which
 * is why the paged story shows it under a row that looks complete.
 *
 * The Frames stories are the exception: they draw the panel's own Camera
 * Frames row, on its catalog copy and its file tiles.
 *
 * Read the phone stories at the Mobile viewports: the frame draws
 * `DetailShell`'s lift surface and body inset, which the strip cancels.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { DETAIL_SHELL_BODY_INSET_PX } from "@/components/detail-shell";
import {
  makeMixedAttachments,
  makePreviewableImages,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { MessageAttachmentSquare } from "@/domains/chat/components/chat-attachments/message-attachment-square";
import {
  CHAT_INFO_FILE_TILE_WIDTH_PX,
  ChatInfoFileTile,
} from "@/domains/chat/components/chat-info-file-tile";
import {
  CHAT_INFO_ASSISTANT_ID,
  withChatInfoStoryClient,
} from "@/domains/chat/components/chat-info-story-fixtures";
import {
  CHAT_INFO_DRAWER_WIDTH_PX,
  CHAT_INFO_NARROW_PHONE_PX,
  chatInfoStoryFrames,
} from "@/domains/chat/components/chat-info.test-helper";
import type { ConversationFileAsset } from "@/domains/chat/hooks/use-conversation-assets";
import type { DisplayAttachment } from "@/domains/chat/types/types";
import { useTranslation } from "@/i18n";

import {
  ChatInfoSection,
  type ChatInfoSectionProps,
} from "./chat-info-section";

/** `MessageAttachmentSquare`'s tile box, the width the fit rule is given. */
const SQUARE_TILE_WIDTH_PX = 64;

/**
 * A category small enough for one line: two photos carrying a real preview,
 * then a deck, a report, and an archive on their kind glyphs.
 */
const FITTING_SET: DisplayAttachment[] = [
  ...makePreviewableImages(2),
  ...makeMixedAttachments().filter((file) => file.previewUrl === null),
];

/** The drawer body's column on the desktop mock, inside `DetailShell`'s lift surface and body inset. */
const inDrawerColumn: Decorator = (Story) => (
  <div
    className="bg-[var(--surface-lift)]"
    style={{ padding: DETAIL_SHELL_BODY_INSET_PX }}
  >
    <div style={{ width: CHAT_INFO_DRAWER_WIDTH_PX }}>
      <Story />
    </div>
  </div>
);

/**
 * A phone page at the shell's body inset, which the strip's negative margin
 * cancels so the tiles run to the screen edge and the last one is cut off, as
 * in the mobile mock.
 */
const inPhonePage: Decorator = (Story) => (
  <div
    className="bg-[var(--surface-lift)]"
    style={{
      maxWidth: CHAT_INFO_NARROW_PHONE_PX,
      padding: DETAIL_SHELL_BODY_INSET_PX,
    }}
  >
    <Story />
  </div>
);

function renderSquare(attachment: DisplayAttachment) {
  return (
    <MessageAttachmentSquare key={attachment.id} attachment={attachment} />
  );
}

const meta = {
  title: "Chat/ChatInfoSection",
  component: ChatInfoSection,
  parameters: { layout: "fullscreen" },
  argTypes: { renderTile: { control: false } },
  args: {
    title: "Documents & Images",
    tileWidth: SQUARE_TILE_WIDTH_PX,
    seeAllAriaLabel: "See all documents and images",
    renderTile: renderSquare,
    onSeeAll: fn(),
  },
} satisfies Meta<ChatInfoSectionProps<DisplayAttachment>>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A category that fits on one line: every tile renders and the header carries
 * no See All, because the count and the fitted line agree.
 */
export const Fit: Story = {
  decorators: [inDrawerColumn],
  args: {
    items: FITTING_SET,
    count: FITTING_SET.length,
  },
};

/**
 * More tiles than the row holds. The line is cut to what fits and See All
 * takes the right edge of the header.
 */
export const Overflow: Story = {
  decorators: [inDrawerColumn],
  args: {
    items: makePreviewableImages(12),
    count: 12,
  },
};

/**
 * A paged category whose first page fits. The row looks complete, but the
 * total is the number See All is decided from, so the drill-in is still
 * offered.
 */
export const PagedCount: Story = {
  decorators: [inDrawerColumn],
  args: {
    items: makePreviewableImages(4),
    count: 240,
  },
};

/**
 * The phone treatment: the whole fetched set on one horizontally scrolling
 * strip, bleeding past the body inset so the last visible tile is cut off at
 * the screen edge.
 */
export const MobileStrip: Story = {
  decorators: [inPhonePage],
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  args: {
    items: makePreviewableImages(8),
    count: 12,
  },
};

/** The same strip on the narrowest phone the app runs on. */
export const NarrowPhoneStrip: Story = {
  decorators: [inPhonePage],
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
  args: {
    items: makePreviewableImages(8),
    count: 12,
  },
};

/** One Live session's captures, the set the frames row is shown against. */
const FRAME_TILES = chatInfoStoryFrames(6);

/** The Camera Frames row the panel draws: its catalog copy, over its file tiles. */
function FramesRow({
  count,
  onSeeAll,
}: Pick<ChatInfoSectionProps<ConversationFileAsset>, "count" | "onSeeAll">) {
  const { t } = useTranslation("chat");
  return (
    <ChatInfoSection
      title={t("chatInfoPanel.framesTitle")}
      count={count}
      items={FRAME_TILES}
      tileWidth={CHAT_INFO_FILE_TILE_WIDTH_PX}
      seeAllAriaLabel={t("chatInfoPanel.seeAllFramesAria")}
      onSeeAll={onSeeAll}
      renderTile={(frame) => (
        <ChatInfoFileTile
          key={frame.id}
          file={frame}
          assistantId={CHAT_INFO_ASSISTANT_ID}
          onOpen={() => {}}
        />
      )}
    />
  );
}

type FramesStory = StoryObj<
  Pick<ChatInfoSectionProps<ConversationFileAsset>, "count" | "onSeeAll">
>;

/**
 * Camera Frames at the drawer width: each tile carries the time its frame was
 * captured, and the session's total puts See All in the header.
 */
export const Frames: FramesStory = {
  decorators: [withChatInfoStoryClient, inDrawerColumn],
  args: { count: 240 },
  render: (args) => <FramesRow {...args} />,
};

/** The same row on the narrowest phone, where the captures scroll past the edge. */
export const FramesStrip: FramesStory = {
  decorators: [withChatInfoStoryClient, inPhonePage],
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
  args: { count: 240 },
  render: (args) => <FramesRow {...args} />,
};
