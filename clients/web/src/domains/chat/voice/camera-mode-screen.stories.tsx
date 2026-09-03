/**
 * Camera mode as one screen: the feed, the two scrims, the status pill, the
 * top-right corner cluster, the shutter row and the session controls, at the
 * offsets and in the stacking order the room gives them.
 *
 * The per-component stories next door each answer one question about one
 * control over video. This file answers the ones only the assembled surface
 * raises: whether the bottom scrim actually reaches past the shutter, whether
 * the thing the user presses repeatedly stays clear of the thing that hangs
 * up, and whether pill, shutter and row read as a single piece of chrome
 * rather than three separate ones that happen to share a frame.
 *
 * Storybook has no `getUserMedia` and no live session, and none of the pieces
 * here takes either: every one of them is presentational, so a gradient stands
 * in for the feed and props stand in for the session. Nothing is a copy of an
 * app component.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  CameraOff,
  ChevronDown,
  Mic,
  MicOff,
  SlidersHorizontal,
  Volume2,
  X,
} from "lucide-react";

// The pill's blink and the shutter's morph and capture pulse are hand-written
// keyframes in the app stylesheet, which Storybook's preview.css does not pull
// in.
import "@/index.css";

import { CAMERA_STORY_FEED, CameraRowScene } from "./camera-story-feed";
import {
  CAMERA_SCRIM_BOTTOM,
  CAMERA_SCRIM_TOP,
} from "./voice-room/camera-mode-paint";
import {
  CameraStatusPill,
  type CameraMode,
} from "./voice-room/camera-status-pill";
import type { CameraVoiceState } from "./voice-room/use-camera-voice-state";
import type { VoiceRoomPhoto } from "./voice-room/use-voice-room-camera";
import { VoiceRoomCaptureRow } from "./voice-room/voice-room-capture-row";
import { VoiceRoomControl } from "./voice-room/voice-room-control";

/**
 * The room's corner gap, which every offset below is measured from.
 *
 * The app writes `max(1.25rem, env(safe-area-inset-bottom))`, so on a notched
 * phone the row clears the home indicator. Storybook is read in a desktop
 * browser inside an iframe, where that `max()` resolves to the gap on its own,
 * and pinning it keeps the composition identical for every reviewer instead of
 * shifting with whatever device the tab is open on. `voice-room.tsx` keeps the
 * real expression.
 */
const STORY_INSET = "1.25rem";

/**
 * The shutter row's offset: the session row's, plus its 52px height, plus the
 * 46px the design leaves between the two. Composed the way the room composes
 * it, since it is the gap that keeps the shutter off the end-session button.
 */
const SHUTTER_ROW_BOTTOM = `calc(6.125rem + ${STORY_INSET})`;

/**
 * The right edge of the band the pill is centred in: the story inset plus the
 * corner cluster (two 52px controls and the 4px between them) plus the 8px the
 * pill never closes. `voice-room.tsx` keeps the real expression, which adds the
 * safe-area inset the room's own controls ride.
 */
const PILL_BAND_RIGHT = `calc(${STORY_INSET} + 7.25rem)`;

/** The shutter's accessible name per mode, mirroring the room's catalog copy. */
const SHUTTER_LABELS: Record<CameraMode, string> = {
  photo: "Take photo",
  live: "Stop live",
};

const noop = () => {};

/**
 * A flat swatch standing in for a captured frame, since the row draws whatever
 * bytes the camera handed it and the question these stories ask is how wide the
 * tiles are, not what is in them.
 */
const captureThumb = (hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><rect width="88" height="88" fill="hsl(${hue} 42% 52%)"/></svg>`,
  )}`;

/** The strip at the cap the camera hook holds it to: three, oldest first. */
const FULL_STRIP: readonly VoiceRoomPhoto[] = [
  { id: 1, previewUrl: captureThumb(28), status: "sent" },
  { id: 2, previewUrl: captureThumb(96), status: "sent" },
  { id: 3, previewUrl: captureThumb(210), status: "sending" },
];

const KEPT_FRAME = {
  attachmentId: "att-story",
  previewUrl: captureThumb(340),
};

interface CameraModeScreenProps {
  /** What the camera is doing. Drives the pill's fill and the shutter's core. */
  mode?: CameraMode;
  /** Whose voice is live, for the pill's dot. */
  voiceState: CameraVoiceState;
  /** What the session is doing, the catalog copy for `liveVoiceSurfaceLabelKey`. */
  statusLabel: string;
  /** The session assistant's name, spoken by the pill while it is talking. */
  assistantName?: string;
  /** Mic off: the control goes red and loses the row's only white fill. */
  micMuted?: boolean;
  /** How many photo receipts sit on the floor's left edge. Capped at three. */
  photos?: number;
  /** Whether Live's newest kept frame sits beside them. */
  keptFrame?: boolean;
}

/**
 * The whole surface, composed from the shipped presentational pieces over a
 * stand-in feed.
 *
 * Everything visible here is the real component: `CameraStatusPill`, the
 * shutter row's `CameraShutter` and `CameraFlashControl` through
 * `CameraRowScene`, and the `VoiceRoomControl`s of the corner cluster and the
 * session row. The corner's view-options control is its trigger only, since
 * the panel it opens reads live stores this scene has none of. What
 * this scene supplies is only what the app supplies around them: the frame,
 * the two scrims, and where each piece sits. In the app that job belongs to
 * `voice-room.tsx`, which wires the same pieces to the live session and the
 * camera, and which is the source of truth for every offset and z-index
 * restated below.
 */
function CameraModeScreen({
  mode = "photo",
  voiceState,
  statusLabel,
  assistantName,
  micMuted = false,
  photos = 0,
  keptFrame = false,
}: CameraModeScreenProps) {
  return (
    <div className="relative h-dvh w-full overflow-hidden bg-black">
      {/* The feed. In the app this is a full-bleed `<video>` (or, on native
          shells, the camera preview behind a transparent web view) at `z-[2]`:
          above the room's look, below its chrome. */}
      <div
        aria-hidden
        className="absolute inset-0 z-[2]"
        style={{ background: CAMERA_STORY_FEED }}
      />

      {/* The two legibility scrims, at the room's own heights. Only the bands
          the chrome lives in carry a tint, so the middle of the frame stays
          untouched, and the bottom one's 15rem floor is what carries it past
          the shutter in a short room. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-[3] h-[22%]"
        style={{ background: CAMERA_SCRIM_TOP }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[3] h-[max(38%,15rem)]"
        style={{ background: CAMERA_SCRIM_BOTTOM }}
      />

      {/* The pill, centred in the band the corner cluster leaves rather than on
          the screen: the cluster holds two controls, and a pill centred on the
          screen would reach under them at phone width before its own floor
          width was spent. */}
      <div
        className="pointer-events-none absolute z-10 flex justify-center"
        style={{ top: STORY_INSET, left: STORY_INSET, right: PILL_BAND_RIGHT }}
      >
        <CameraStatusPill
          mode={mode}
          voiceState={voiceState}
          statusLabel={statusLabel}
          assistantName={assistantName}
        />
      </div>

      {/* The corner cluster: the camera's view options, then minimize on the
          extreme corner. Both wear the glass corner treatment rather than the
          session row's fills, so the corner reads as chrome over the feed
          instead of joining the row of acts at the bottom. */}
      <div
        className="absolute z-10 flex items-center gap-1"
        style={{ top: STORY_INSET, right: STORY_INSET }}
      >
        <VoiceRoomControl
          bare
          surface="camera"
          label="Camera view options"
          onClick={noop}
        >
          <SlidersHorizontal className="size-5" />
        </VoiceRoomControl>
        <VoiceRoomControl
          bare
          surface="camera"
          label="Minimize voice room"
          onClick={noop}
        >
          <ChevronDown className="size-5" />
        </VoiceRoomControl>
      </div>

      {/* The shutter row, a row of its own above the session controls, with
          the hint over it and the capture row above that. Full width here
          because the app's is: flash and flip ride the room's edges rather
          than a fixed measure, and the capture row rides the left one. The
          room shows the hint only where Live can run; this screen always can,
          so it always carries one. */}
      <div
        className="absolute inset-x-0 z-10 flex flex-col items-center gap-3"
        style={{ bottom: SHUTTER_ROW_BOTTOM }}
      >
        <VoiceRoomCaptureRow
          photos={FULL_STRIP.slice(0, photos)}
          keptFrame={keptFrame ? KEPT_FRAME : null}
        />
        <CameraRowScene
          className="w-full"
          hint={{ mode }}
          shutter={{ mode, ariaLabel: SHUTTER_LABELS[mode], onClick: noop }}
        />
      </div>

      {/* The session row: mute the mic, mute the assistant, close the camera,
          end the call. Four filled circles at the row's own 16px gap, told
          apart by what they do rather than by an outline. */}
      <div
        className="absolute inset-x-0 z-10 flex items-center justify-center gap-4"
        style={{ bottom: STORY_INSET }}
      >
        <VoiceRoomControl
          surface="camera"
          tone={micMuted ? "destructive" : "live"}
          pressed={micMuted}
          label={micMuted ? "Unmute microphone" : "Mute microphone"}
          onClick={noop}
        >
          {micMuted ? (
            <MicOff className="size-5" />
          ) : (
            <Mic className="size-5" />
          )}
        </VoiceRoomControl>
        <VoiceRoomControl
          surface="camera"
          label="Mute assistant"
          onClick={noop}
        >
          <Volume2 className="size-5" />
        </VoiceRoomControl>
        <VoiceRoomControl
          surface="camera"
          pressed
          label="Close camera"
          onClick={noop}
        >
          <CameraOff className="size-5" />
        </VoiceRoomControl>
        <VoiceRoomControl
          surface="camera"
          tone="destructive"
          label="End voice session"
          onClick={noop}
        >
          <X className="size-5" strokeWidth={2.5} />
        </VoiceRoomControl>
      </div>
    </div>
  );
}

const meta: Meta<typeof CameraModeScreen> = {
  title: "Chat/Voice/CameraModeScreen",
  component: CameraModeScreen,
  parameters: { layout: "fullscreen" },
  // A phone, since that is the device the surface is built for: a viewfinder
  // held at arm's length, aimed one-handed. The `Desktop` story below is the
  // one width this default takes out of reach.
  globals: { viewport: { value: "sbMobile" } },
  args: {
    mode: "photo",
    voiceState: "idle",
    statusLabel: "Listening…",
    assistantName: "Luna",
    micMuted: false,
    photos: 0,
    keptFrame: false,
  },
  argTypes: {
    mode: {
      options: ["photo", "live"],
      control: { type: "inline-radio" },
      description:
        "What the camera is doing. Drives the pill's fill and the shutter's core together, which is the pairing the app cannot show.",
    },
    voiceState: {
      options: ["idle", "user", "assistant"],
      control: { type: "inline-radio" },
      description:
        "Whose voice is live. The room derives it; the pill paints it.",
    },
    photos: {
      options: [0, 1, 2, 3],
      control: { type: "inline-radio" },
      description:
        "How many photo receipts are on the floor. Three is the cap the camera hook holds the strip to.",
    },
    statusLabel: {
      options: [
        "Connecting…",
        "Reconnecting…",
        "Listening…",
        "Muted",
        "Thinking…",
        "Speaking…",
        "Ending…",
        "",
      ],
      control: { type: "select" },
      description:
        "What the session is doing, the catalog copy for `liveVoiceSurfaceLabelKey`.",
    },
  },
};

export default meta;
type Story = StoryObj<typeof CameraModeScreen>;

/**
 * The resting surface: camera open, session hearing you, nobody talking.
 *
 * The read to check is the vertical rhythm. The pill sits on the same line the
 * minimize control would, the shutter clears the session row by the design's
 * 46px, and the bottom scrim reaches above the shutter rather than stopping
 * between the two rows.
 */
export const PhotoIdle: Story = {};

/**
 * The user talking. The pill's dot goes solid white and blinks, and nothing
 * else on the surface moves: a viewfinder that reacted to speech would fight
 * the thing the user is aiming at.
 */
export const PhotoUserSpeaking: Story = { args: { voiceState: "user" } };

/**
 * The assistant answering: the rose dot, and her name where the session word
 * was. The name is the only text on the surface that changes per turn, which
 * is why the pill holds a floor width rather than re-centring on every one.
 */
export const AssistantSpeaking: Story = {
  args: { voiceState: "assistant", statusLabel: "Speaking…" },
};

/**
 * Mic off, at rest. The pill says so and the mic control goes red, so the row
 * loses its one white fill: that absence is the read to check, since with the
 * viewfinder up nothing else on screen answers "can she still hear me".
 */
export const Muted: Story = {
  args: { statusLabel: "Muted", micMuted: true },
};

/**
 * The same red mic while the assistant is mid-sentence.
 *
 * Two facts at once, which is the case a single indicator gets wrong: the
 * input is off, and the output is still running. The row shows the first and
 * the pill's rose dot shows the second, and muting the mic changes nothing
 * about the second.
 */
export const MicMutedControls: Story = {
  args: {
    voiceState: "assistant",
    statusLabel: "Speaking…",
    micMuted: true,
  },
};

/**
 * Streaming rather than sampling, on all three pieces that carry the mode: the
 * pill fills with the capture accent, the shutter's core morphs to the crimson
 * record dot, and the hint above it changes from what a hold offers to how to
 * stop.
 *
 * What the app reaches by holding the shutter, and the one place the three can
 * be read against each other in one frame.
 */
export const LiveMode: Story = { args: { mode: "live" } };

/**
 * A configured name long enough to run out of room, at the width where it has
 * the least: the case the corner cluster made harder by taking a second
 * control.
 *
 * The read to check is the right edge. The name truncates to an ellipsis, the
 * dot and the mode word stay whole, and nothing about the pill reaches the
 * view-options button beside minimize.
 */
export const LongAssistantName: Story = {
  args: {
    voiceState: "assistant",
    statusLabel: "Speaking…",
    assistantName: "A considerably longer configured assistant name",
  },
};

/**
 * The floor at its fullest, at the narrowest width the app runs at: the photo
 * strip at its three-tile cap, Live's kept frame beside it, and the shutter in
 * Live below.
 *
 * The read to check is the capture row's right edge against the shutter's
 * column. Four 44px tiles and the 8px between them is 200px of content behind a
 * 24px offset, so at 320px the row ends well short of the right edge and holds
 * a line of its own above the shutter, rather than wrapping, scrolling, or
 * running under the flip control.
 *
 * This composition belongs to a phone and reaches one only through the native
 * frame source, so this story is where its geometry is answerable: a desktop
 * width has slack enough to hide whether the row fits.
 */
export const NarrowPhoneCaptureRow: Story = {
  args: { mode: "live", photos: 3, keptFrame: true },
  globals: { viewport: { value: "sbNarrowPhone" } },
};

/**
 * The same composition at a desktop width, which is the room's `content` and
 * `sheet` variants on a laptop.
 *
 * Everything centred stays centred and the scrims stretch, but the shutter
 * row's flanks ride the wider edge: flash and flip pull apart while the
 * shutter holds the middle, so the thumb-reach argument for their offsets is a
 * phone's argument, and this is what it costs on a wide panel.
 */
export const Desktop: Story = {
  globals: { viewport: { value: "sbDesktop" } },
};
