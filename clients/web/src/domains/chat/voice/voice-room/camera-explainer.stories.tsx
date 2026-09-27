/**
 * The "Photo or Live?" explainer, over a stand-in for the camera feed.
 *
 * Storybook has no `getUserMedia` and no room, and the explainer takes neither:
 * it is handed the element it renders into and the assistant's name, so a
 * gradient inside a positioned box is a complete substitute for the surface it
 * covers in the app.
 *
 * Both presentations are here because both ship: the sheet is what a phone
 * gets, and the modal is real rather than theoretical, since Live is offered on
 * Electron and on browser web with a webcam.
 *
 * `useTouchSurface` is a narrow viewport AND a coarse pointer, so a phone-width
 * story in a desktop browser still draws the modal. The sheet stories force the
 * query through `withTouchSurface`.
 */

import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

// The reduced-motion fade the sheet swaps its entrance for is a hand-written
// keyframe in the app stylesheet, which Storybook's preview.css does not pull
// in.
import "@/index.css";

import {
  CAMERA_STORY_FEED,
  CAMERA_STORY_FEED_DIM,
} from "@/domains/chat/voice/camera-story-feed";
import { withTouchSurface } from "@/lib/story-touch-surface";

import { CameraExplainer } from "./camera-explainer";

interface FakeRoomProps {
  /** Which frame the explainer is read against. */
  background: string;
  assistantName: string;
  tryLiveOffered: boolean;
  /**
   * A stand-in for the chat sidebar beside the room. The desktop stories run
   * with one so the scrim can be read stopping at the room's edge rather than
   * covering the window.
   */
  sidebar: boolean;
}

/**
 * The room box as far as this component is concerned: a positioned,
 * `overflow-hidden` frame holding the full-size, press-through host the room
 * gives the explainer, committed through state exactly as the room commits it.
 */
function FakeRoom({
  background,
  assistantName,
  tryLiveOffered,
  sidebar,
}: FakeRoomProps): ReactNode {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(true);

  return (
    <div className="flex h-dvh w-full bg-[#141312]">
      {sidebar ? (
        <div
          data-testid="fake-sidebar"
          className="h-full w-[260px] shrink-0 border-r border-white/6 bg-[#1a1817]"
        />
      ) : null}
      <div
        data-testid="fake-room"
        className="relative h-full min-w-0 flex-1 overflow-hidden"
        style={{ background }}
      >
        <div
          ref={setHost}
          className="pointer-events-none absolute inset-0 z-30"
        />
        <CameraExplainer
          open={open}
          host={host}
          assistantName={assistantName}
          tryLiveOffered={tryLiveOffered}
          onDismiss={() => setOpen(false)}
        />
      </div>
    </div>
  );
}

const meta: Meta<typeof FakeRoom> = {
  title: "Chat/Voice/CameraExplainer",
  component: FakeRoom,
  tags: ["!autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    background: CAMERA_STORY_FEED,
    assistantName: "Luna",
    tryLiveOffered: true,
    sidebar: false,
  },
  argTypes: {
    background: { control: false },
  },
};

export default meta;
type Story = StoryObj<typeof FakeRoom>;

/** The touch-surface query plus the phone viewport the design is drawn at. */
const phone = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  decorators: [withTouchSurface],
} satisfies Partial<Story>;

/**
 * The canonical phone frame: grabber, serif title, the two cards side by side,
 * the privacy line, then the full-width primary with the text button under it.
 * Read the sheet's height against the feed: it is content-sized, not a fixed
 * band.
 */
export const Sheet: Story = { ...phone };

/**
 * The narrowest screen the app runs on. The two cards still share a row, so
 * what has to hold is the card body wrapping rather than the grid collapsing.
 */
export const SheetNarrowPhone: Story = {
  ...phone,
  globals: { viewport: { value: "sbNarrowPhone", isRotated: false } },
};

/**
 * Live already running, which the assistant's spoken ask can arrange before the
 * user has read any of this. There is nothing left to try, so the secondary
 * goes and the primary is the only way out besides the scrim. Both cards stay:
 * the user is in one of the two modes they describe.
 */
export const SheetWithoutTryLive: Story = {
  ...phone,
  args: { tryLiveOffered: false },
};

/** Desktop, with a stand-in sidebar so the room is narrower than the window. */
const pane = {
  globals: { viewport: { value: "sbDesktop", isRotated: false } },
  args: { sidebar: true },
} satisfies Partial<Story>;

/**
 * The pointer presentation. The library's own close glyph is the third way out,
 * the privacy line sits left of the buttons and is allowed two lines, and the
 * Live card carries the extra sentence the phone drops.
 *
 * What the sidebar is here for: the scrim stops at the room's left edge and the
 * dialog is centred in the room, not in the window.
 */
export const Modal: Story = { ...pane };

/**
 * The same modal over a dim frame. The scrim and the sheet surface are both
 * dark, so this is where the card borders have to carry the edges on their own.
 */
export const ModalOverDimFeed: Story = {
  ...pane,
  args: { ...pane.args, background: CAMERA_STORY_FEED_DIM },
};

/**
 * A pointer surface with no room to spare. `useTouchSurface` wants a narrow
 * viewport AND a coarse pointer, so a tiled window or a landscape phone lands
 * here rather than on the sheet. The dialog stops at the pane's height and its
 * body scrolls, leaving the close glyph pinned; narrower than this the privacy
 * line takes its own row above the buttons instead of squeezing them.
 */
export const ModalShortPane: Story = {
  globals: { viewport: { value: "sbShort", isRotated: false } },
};
