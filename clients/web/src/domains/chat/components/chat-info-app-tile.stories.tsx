/**
 * The Chat Info panel's app tile: a live preview of the app, its options menu
 * revealed over the preview, and the app's name beneath.
 *
 * The previews are real: each story primes the app-html cache the tile reads,
 * so the iframe renders a small page instead of the icon placeholder. Hover a
 * tile to see the options menu appear; on a touch device it is always visible.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
  CHAT_INFO_ASSISTANT_ID,
  CHAT_INFO_CONVERSATION_ID,
  chatInfoApps,
  primeChatInfoAppPreviews,
  withChatInfoStoryClient,
} from "@/domains/chat/components/chat-info-story-fixtures";
import {
  CHAT_INFO_BODY_WIDTH_PX,
  makeAppSummary,
  makeChatInfoQueryClient,
  seedChatInfoConversation,
} from "@/domains/chat/components/chat-info.test-helper";

import { ChatInfoAppTile } from "./chat-info-app-tile";

const FEATURED = chatInfoApps(3);
const TRIP_PLANNER = FEATURED[0]!;
const PACKING_LIST = FEATURED[1]!;
const FERRY_TIMES = FEATURED[2]!;

const LONG_NAME = makeAppSummary({
  id: "app-itinerary",
  name: "Coastal Itinerary and Harbour Tour Booking Planner",
  icon: "🗺️",
});
/** Never primed, so its preview never resolves and the tile keeps the icon. */
const NO_PREVIEW = makeAppSummary({
  id: "app-field-notes",
  name: "Field Notes",
  icon: "📓",
});

const PRIMED = [...FEATURED, LONG_NAME];
primeChatInfoAppPreviews(CHAT_INFO_ASSISTANT_ID, PRIMED);

const storyClient = makeChatInfoQueryClient();
// The options menu reads the app list to know whether the app is pinned.
seedChatInfoConversation(storyClient, {
  assistantId: CHAT_INFO_ASSISTANT_ID,
  conversationId: CHAT_INFO_CONVERSATION_ID,
  apps: [...PRIMED, NO_PREVIEW],
});

const meta: Meta<typeof ChatInfoAppTile> = {
  title: "Chat/ChatInfoAppTile",
  component: ChatInfoAppTile,
  parameters: { layout: "centered" },
  decorators: [withChatInfoStoryClient(storyClient)],
  args: {
    app: TRIP_PLANNER,
    assistantId: CHAT_INFO_ASSISTANT_ID,
    onOpen: fn(),
    onRequestDelete: fn(),
  },
};
export default meta;

type Story = StoryObj<typeof ChatInfoAppTile>;

/** One tile at its fixed 184px width, the size it keeps in a strip or a grid. */
export const Default: Story = {};

/**
 * Three stretched tiles sharing the 569px panel body, which is what the fitted
 * row does: each tile takes an equal share rather than its fixed width.
 */
export const Stretched: Story = {
  args: { stretch: true },
  render: (args) => (
    <div className="flex gap-2" style={{ width: CHAT_INFO_BODY_WIDTH_PX }}>
      <ChatInfoAppTile {...args} app={TRIP_PLANNER} />
      <ChatInfoAppTile {...args} app={PACKING_LIST} />
      <ChatInfoAppTile {...args} app={FERRY_TIMES} />
    </div>
  ),
};

/** An app whose preview has not resolved: the icon holds the box instead. */
export const NoPreview: Story = {
  args: { app: NO_PREVIEW },
};

/** A name wider than the tile, truncated with the full name in the tooltip. */
export const LongName: Story = {
  args: { app: LONG_NAME },
};
