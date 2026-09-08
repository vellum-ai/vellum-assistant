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

import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { AppSummary } from "@/types/app-types";
import { primeAppHtmlCache } from "@/utils/app-html-cache";

import { ChatInfoAppTile } from "./chat-info-app-tile";

const ASSISTANT_ID = "story-assistant";

function makeApp(id: string, name: string, icon: string): AppSummary {
  return {
    id,
    name,
    icon,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_100_000,
    version: "1.0.0",
    contentId: `${id}-content`,
    origin: "workspace",
  };
}

const TRIP_PLANNER = makeApp("app-trip-planner", "Trip Planner", "🧭");
const PACKING_LIST = makeApp("app-packing-list", "Packing List", "🧳");
const FERRY_TIMES = makeApp("app-ferry-times", "Ferry Times", "⛴️");
const LONG_NAME = makeApp(
  "app-itinerary",
  "Coastal Itinerary and Harbour Tour Booking Planner",
  "🗺️",
);
/** Never primed, so its preview never resolves and the tile keeps the icon. */
const NO_PREVIEW = makeApp("app-field-notes", "Field Notes", "📓");

/** A small page for the preview iframe, using system colours so it reads in either theme. */
function previewHtml(title: string, items: string[]): string {
  const list = items.map((item) => `<li>${item}</li>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;padding:24px;font-family:system-ui,sans-serif;background:Canvas;color:CanvasText}h1{margin:0 0 12px;font-size:28px}ul{margin:0;padding-left:22px;font-size:18px;line-height:1.7}</style><h1>${title}</h1><ul>${list}</ul>`;
}

const PRIMED: Array<[AppSummary, string[]]> = [
  [TRIP_PLANNER, ["Book the ferry", "Pack a rain shell", "Confirm the tour"]],
  [PACKING_LIST, ["Rain shell", "Walking boots", "Ferry tickets"]],
  [FERRY_TIMES, ["07:40 harbour", "11:15 harbour", "16:50 harbour"]],
  [LONG_NAME, ["Day 1 coast road", "Day 2 harbour", "Day 3 return"]],
];

for (const [app, items] of PRIMED) {
  primeAppHtmlCache(ASSISTANT_ID, app.id, previewHtml(app.name, items));
}

const storyClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
// The options menu reads the app list to know whether the app is pinned.
storyClient.setQueryData(
  appsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
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
    assistantId: ASSISTANT_ID,
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
