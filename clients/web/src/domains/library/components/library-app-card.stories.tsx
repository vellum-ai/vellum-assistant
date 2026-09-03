import type { Meta, StoryObj } from "@storybook/react-vite";

import { LibraryAppCard } from "@/domains/library/components/library-app-card";
import { makeAppSummary } from "@/types/app-summary.test-helper";

/**
 * A card in the library grid.
 *
 * The grid itself paints nothing (`library-grid-section` is a bare `grid` with
 * a gap), so the card's title and date sit directly on the page surface and
 * only the preview thumbnail carries a fill of its own. That is what these
 * stories are for: the card's own surface is the whole of what a reader sees
 * behind its text, on every pointer.
 *
 * The thumbnail renders its fallback here, because a story has no cached app
 * HTML to load. That is the same fallback a real card shows before its preview
 * is cached, so it is the surface under test rather than a stand-in.
 */
const meta = {
  title: "Library/LibraryAppCard",
  component: LibraryAppCard,
  parameters: {
    layout: "centered",
  },
  args: {
    app: makeAppSummary({
      id: "app-1",
      name: "Standup Notes",
      icon: "📝",
      createdAt: Date.UTC(2026, 0, 14),
    }),
    assistantId: "asst-1",
    isPinned: false,
    onOpen: () => {},
    onPin: () => {},
    onDelete: () => {},
  },
  argTypes: {
    onOpen: { control: false },
    onPin: { control: false },
    onDelete: { control: false },
    onDeploy: { control: false },
    onAnimationEnd: { control: false },
    app: { control: false },
  },
  decorators: [
    (Story) => (
      <div className="w-[260px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LibraryAppCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Pinned: Story = {
  args: { isPinned: true },
};

/**
 * The same card under a thumb.
 *
 * `SwipeActionReveal` arms only on a coarse pointer, so this is the one
 * viewport where the card is wrapped in swipe layers at all. What the story
 * documents is that being wrapped changes nothing a reader can see: the card
 * reads exactly as it does above, with no band behind the title and date and
 * no action showing until a swipe reveals one.
 *
 * Storybook's viewport emulation resizes without reporting a coarse pointer,
 * so the swipe layers mount only when the browser itself reports one (device
 * emulation in devtools, or a real phone). The card is the subject either way.
 */
export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};

/**
 * A plugin-bundled app. The daemon rejects delete, share and deploy against
 * one, so the card drops those rather than offering buttons that error; pin
 * and open stay.
 */
export const ReadOnly: Story = {
  args: {
    app: makeAppSummary({
      id: "app-2",
      name: "Inbox Triage",
      icon: "📥",
      origin: "plugin",
      createdAt: Date.UTC(2026, 0, 14),
    }),
  },
};
