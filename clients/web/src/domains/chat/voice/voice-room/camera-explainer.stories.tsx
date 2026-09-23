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
 * query, the way the activation modal's stories do.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { TOUCH_SURFACE_MEDIA_QUERY } from "@vellumai/design-library";

// The reduced-motion fade the sheet swaps its entrance for is a hand-written
// keyframe in the app stylesheet, which Storybook's preview.css does not pull
// in.
import "@/index.css";

import {
  CAMERA_STORY_FEED,
  CAMERA_STORY_FEED_DIM,
} from "@/domains/chat/voice/camera-story-feed";

import { CameraExplainer } from "./camera-explainer";

/** Swap `window.matchMedia`; `configurable` so the teardown can put it back. */
function setMatchMedia(impl: typeof window.matchMedia): void {
  Object.defineProperty(window, "matchMedia", {
    value: impl,
    configurable: true,
    writable: true,
  });
}

/**
 * Forces the sheet branch of `useTouchSurface` for the duration of the story.
 *
 * Installed from a `useState` initializer, which runs once and during this
 * component's render, so no child has sampled the query yet.
 */
function ForceTouchSurface({ children }: { children: ReactNode }): ReactNode {
  const [original] = useState(() => {
    const saved = window.matchMedia.bind(window);
    setMatchMedia(((query: string) => {
      const result = saved(query);
      if (query !== TOUCH_SURFACE_MEDIA_QUERY) {
        return result;
      }
      return {
        ...result,
        media: query,
        matches: true,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList;
    }) as typeof window.matchMedia);
    return saved;
  });
  useEffect(() => () => setMatchMedia(original), [original]);
  return <>{children}</>;
}

interface FakeRoomProps {
  /** Which frame the explainer is read against. */
  background: string;
  assistantName: string;
  tryLiveOffered: boolean;
}

/**
 * The room box as far as this component is concerned: a positioned,
 * `overflow-hidden` frame with the zero-size host the room hangs its camera
 * overlays off, committed through state exactly as the room commits it.
 */
function FakeRoom({
  background,
  assistantName,
  tryLiveOffered,
}: FakeRoomProps): ReactNode {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(true);

  return (
    <div
      className="relative h-dvh w-full overflow-hidden"
      style={{ background }}
    >
      <div ref={setHost} className="absolute top-0 left-0 z-30" />
      <CameraExplainer
        open={open}
        host={host}
        assistantName={assistantName}
        tryLiveOffered={tryLiveOffered}
        onDismiss={() => setOpen(false)}
      />
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
  decorators: [
    (Story: () => ReactNode) => (
      <ForceTouchSurface>
        <Story />
      </ForceTouchSurface>
    ),
  ],
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
 * Live not on offer: the secondary goes and the primary is the only way out
 * besides the scrim. This is what a session below the Live gate sees.
 */
export const SheetWithoutTryLive: Story = {
  ...phone,
  args: { tryLiveOffered: false },
};

/**
 * The pointer presentation. The library's own close glyph is the third way out,
 * the privacy line sits left of the buttons and is allowed two lines, and the
 * Live card carries the extra sentence the phone drops.
 */
export const Modal: Story = {
  globals: { viewport: { value: "sbDesktop", isRotated: false } },
};

/**
 * The same modal over a dim frame. The scrim and the sheet surface are both
 * dark, so this is where the card borders have to carry the edges on their own.
 */
export const ModalOverDimFeed: Story = {
  globals: { viewport: { value: "sbDesktop", isRotated: false } },
  args: { background: CAMERA_STORY_FEED_DIM },
};
