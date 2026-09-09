/**
 * The Chat Info panel: a conversation's apps, its documents and images, and
 * the See All grid each category drills into.
 *
 * Nothing here is a stand-in. Every story seeds the two sources the panel's
 * real hooks read (the query cache for apps and documents, the chat-session
 * store for the transcript the attachments come from), so the rows are built
 * by the shipped code path and the app tiles render live previews. One
 * decorator does that seeding for every story; a story that wants a different
 * conversation names it in `parameters.chatInfo`.
 *
 * There is no Camera Frames story. The seeded transcript carries no frame tag,
 * so that row has nothing to build from until frames come from the daemon's
 * attachment list.
 *
 * The frame is the shipped drawer, so a story opens at its 400px default and
 * the rows fit what that width holds. Drag the drawer's left edge to walk the
 * fit rule out to the mock's wider column.
 *
 * Read the phone stories at the Mobile viewports: there the rows become
 * horizontal strips that run past the panel's body inset to the screen edge.
 */

import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { fn, userEvent, within } from "storybook/test";

import {
  makeMixedAttachments,
  makePreviewableImages,
} from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import {
  CHAT_INFO_ASSISTANT_ID,
  CHAT_INFO_CONVERSATION_ID,
  type ChatInfoStoryConversation,
  inChatInfoConversation,
} from "@/domains/chat/components/chat-info-story-fixtures";
import { DetailPanelStoryFrame } from "@/domains/chat/components/detail-panel-story-frame";
import type { ChatInfoCategory } from "@/stores/viewer-store";

import { ChatInfoPanel } from "./chat-info-panel";

/**
 * A file-heavy conversation, so the Documents & Images grid is worth seeing.
 * The mixed set's leading image is dropped: it repeats `img-0` from the
 * previewable set, and two entries sharing an attachment id collapse to one
 * tile.
 */
const FILE_HEAVY: Partial<ChatInfoStoryConversation> = {
  appCount: 3,
  documentCount: 3,
  attachments: [
    ...makePreviewableImages(8),
    ...makeMixedAttachments().slice(1),
  ],
};

const inDrawer: Decorator = (Story) => (
  <DetailPanelStoryFrame>
    <Story />
  </DetailPanelStoryFrame>
);

const meta: Meta<typeof ChatInfoPanel> = {
  title: "Chat/ChatInfoPanel",
  component: ChatInfoPanel,
  parameters: { layout: "fullscreen" },
  decorators: [inChatInfoConversation, inDrawer],
  args: {
    payload: {
      assistantId: CHAT_INFO_ASSISTANT_ID,
      conversationId: CHAT_INFO_CONVERSATION_ID,
      category: null,
    },
    onClose: fn(),
    onSelectCategory: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof ChatInfoPanel>;

/**
 * The panel as a working conversation leaves it: twelve apps and four files,
 * both more than one line of the default-width drawer holds, so each row is
 * truncated to what fits and offers See All.
 */
export const Default: Story = {};

/**
 * A young conversation, sized to the default drawer: one app and one document,
 * so every tile is on show and neither header carries a See All.
 */
export const FewAssets: Story = {
  parameters: {
    chatInfo: { appCount: 1, documentCount: 1, attachments: [] },
  },
};

/**
 * Drilled into Apps: the back control takes the header's leading slot, the
 * title becomes the category and its total, and every app gets a tile.
 */
export const AppsSeeAll: Story = {
  args: {
    payload: {
      assistantId: CHAT_INFO_ASSISTANT_ID,
      conversationId: CHAT_INFO_CONVERSATION_ID,
      category: "apps",
    },
  },
};

/** The same drill-in for Documents & Images, where the tiles wrap rather than grid. */
export const FilesSeeAll: Story = {
  parameters: { chatInfo: FILE_HEAVY },
  args: {
    payload: {
      assistantId: CHAT_INFO_ASSISTANT_ID,
      conversationId: CHAT_INFO_CONVERSATION_ID,
      category: "files",
    },
  },
};

/** The phone treatment: each row scrolls horizontally past the screen edge. */
export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/** The same strips on the narrowest phone the app runs on. */
export const NarrowPhone: Story = {
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
};

/**
 * The drill-in as the app runs it. The args-backed stories cannot show the
 * transition, because their `onSelectCategory` is a spy; this one owns the
 * category itself, so See All actually walks the panel to its second level.
 */
export const LevelTwoInteraction: Story = {
  render: function LevelTwoInteraction() {
    const [category, setCategory] = useState<ChatInfoCategory | null>(null);
    return (
      <ChatInfoPanel
        payload={{
          assistantId: CHAT_INFO_ASSISTANT_ID,
          conversationId: CHAT_INFO_CONVERSATION_ID,
          category,
        }}
        onClose={() => setCategory(null)}
        onSelectCategory={setCategory}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByLabelText("See all apps"));
    // Finding the back control is the assertion: the second level is up.
    await canvas.findByLabelText("Back to chat info");
  },
};
