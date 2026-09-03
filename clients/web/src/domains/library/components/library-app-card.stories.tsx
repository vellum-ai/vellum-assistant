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
 * behind its text. Storybook reports a fine pointer, so these show the card
 * without its touch-only swipe wrapper; that branch is checked with real
 * device emulation rather than a story that could only pretend to.
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
    onDeploy: () => {},
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
 * A plugin-bundled app. The assistant rejects delete, share and deploy against
 * one, so the card drops those rather than offering buttons that error; pin
 * and open stay. `onDeploy` is supplied here as in production, so what removes
 * the action is the app's origin and not a missing handler.
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
