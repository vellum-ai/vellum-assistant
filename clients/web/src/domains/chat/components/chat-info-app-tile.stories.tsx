/**
 * The Chat Info panel's app tile: a live preview of the app, its options menu
 * revealed over the preview, and the app's name beneath.
 *
 * The previews are real: each story primes the app-html cache the tile reads,
 * so the iframe renders a small page instead of the icon placeholder. Hover a
 * tile to see the options menu appear; on a touch device it is always visible.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import {
  CHAT_INFO_ASSISTANT_ID,
  chatInfoPreviewHtml,
} from "@/domains/chat/components/chat-info-story-fixtures";
import { makeAppSummary } from "@/domains/chat/components/chat-info.test-helper";
import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppSummary } from "@/types/app-types";
import { primeAppHtmlCache } from "@/utils/app-html-cache";

import { ChatInfoAppTile } from "./chat-info-app-tile";

const TRIP_PLANNER = makeAppSummary({
  id: "app-trip-planner",
  name: "Trip Planner",
});
const PACKING_LIST = makeAppSummary({
  id: "app-packing-list",
  name: "Packing List",
  icon: "🧳",
});
const FERRY_TIMES = makeAppSummary({
  id: "app-ferry-times",
  name: "Ferry Times",
  icon: "⛴️",
});
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

const PRIMED: Array<[AppSummary, string[]]> = [
  [TRIP_PLANNER, ["Book the ferry", "Pack a rain shell", "Confirm the tour"]],
  [PACKING_LIST, ["Rain shell", "Walking boots", "Ferry tickets"]],
  [FERRY_TIMES, ["07:40 harbour", "11:15 harbour", "16:50 harbour"]],
  [LONG_NAME, ["Day 1 coast road", "Day 2 harbour", "Day 3 return"]],
];

for (const [app, items] of PRIMED) {
  primeAppHtmlCache(
    CHAT_INFO_ASSISTANT_ID,
    app.id,
    chatInfoPreviewHtml(app.name, items),
  );
}

const storyClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
// The options menu reads the app list to know whether the app is pinned.
storyClient.setQueryData(
  appsGetQueryKey({ path: { assistant_id: CHAT_INFO_ASSISTANT_ID } }),
  {
    apps: [TRIP_PLANNER, PACKING_LIST, FERRY_TIMES, LONG_NAME, NO_PREVIEW],
  },
);

const withPrimedPreviews: Decorator = (Story) => (
  <QueryClientProvider client={storyClient}>
    <Story />
  </QueryClientProvider>
);

const meta: Meta<typeof ChatInfoAppTile> = {
  title: "Chat/ChatInfoAppTile",
  component: ChatInfoAppTile,
  parameters: { layout: "centered" },
  decorators: [withPrimedPreviews],
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
    <div className="flex w-[569px] gap-2">
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
