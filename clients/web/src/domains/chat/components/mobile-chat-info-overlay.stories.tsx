/**
 * The phone host for Chat Info: the same panel the drawer shows, given the
 * whole screen.
 *
 * There is no frame around it. The overlay is `position: fixed` under the
 * safe-area inset, so what these stories document is the presentation itself:
 * the panel's own header sits at the top of the viewport and its rows run to
 * both screen edges, with no drawer chrome and nothing of the chat behind it.
 *
 * The conversation comes from the shared Chat Info fixtures, so this shows the
 * same apps, documents, and images the panel stories do, built by the panel's
 * real hooks rather than a stand-in.
 *
 * Only ever mounted on a narrow window, hence the Mobile viewport on the meta.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
  CHAT_INFO_ASSISTANT_ID,
  CHAT_INFO_CONVERSATION_ID,
  inChatInfoConversation,
} from "@/domains/chat/components/chat-info-story-fixtures";

import { MobileChatInfoOverlay } from "./mobile-chat-info-overlay";

const meta: Meta<typeof MobileChatInfoOverlay> = {
  title: "Chat/MobileChatInfoOverlay",
  component: MobileChatInfoOverlay,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  decorators: [inChatInfoConversation],
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
type Story = StoryObj<typeof MobileChatInfoOverlay>;

/**
 * The top level, full screen: every category shows one row of tiles that
 * scrolls horizontally past the screen edge, and the close control is the
 * panel's own.
 */
export const Open: Story = {};

/**
 * Drilled into Apps. The level lives in the payload rather than the panel, so
 * the overlay can remount without losing it.
 */
export const AppsLevel: Story = {
  args: {
    payload: {
      assistantId: CHAT_INFO_ASSISTANT_ID,
      conversationId: CHAT_INFO_CONVERSATION_ID,
      category: "apps",
    },
  },
};

/** The same drill-in for Documents & Images, where the tiles wrap into a grid. */
export const FilesLevel: Story = {
  args: {
    payload: {
      assistantId: CHAT_INFO_ASSISTANT_ID,
      conversationId: CHAT_INFO_CONVERSATION_ID,
      category: "files",
    },
  },
};

/** The top level at the width the phone designs are drawn for. */
export const CompactPhone: Story = {
  globals: { viewport: { value: "sbCompactPhone", isRotated: false } },
};
