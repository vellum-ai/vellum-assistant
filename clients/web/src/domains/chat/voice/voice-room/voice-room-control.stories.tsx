/**
 * The room's circular controls in camera mode, over a stand-in for the feed.
 *
 * Camera mode only. The other two surfaces tone themselves from the assistant's
 * avatar through the `--room-*` contract, which is the room's to publish and
 * has no meaning outside it; the camera palette is fixed, published by the
 * control itself, and therefore the one that can be read honestly here.
 *
 * The row is the point rather than any single control: the read to check is
 * that white, warm and red separate at arm's length, and in particular that a
 * live mic never reads as a muted one.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { CameraOff, Mic, MicOff, Volume2, VolumeX, X } from "lucide-react";

import { overFakeFeed, ToneCell } from "@/domains/chat/voice/camera-story-feed";

import { VoiceRoomControl } from "./voice-room-control";

const meta: Meta<typeof VoiceRoomControl> = {
  title: "Chat/Voice/VoiceRoomControl",
  component: VoiceRoomControl,
  parameters: { layout: "fullscreen" },
  decorators: [overFakeFeed({ direction: "column" })],
  args: { surface: "camera", onClick: () => {} },
};

export default meta;
type Story = StoryObj<typeof VoiceRoomControl>;

/**
 * The five states the row can be in, captioned.
 *
 * The mic is the one to read first. A viewfinder covers the room's face, so a
 * live mic goes solid white with a dark glyph rather than leaving "is she still
 * listening" to an absence of red; red belongs to the mic that is genuinely
 * off.
 */
export const CameraTones: Story = {
  render: (args) => (
    <div className="flex items-start gap-6">
      <ToneCell caption="mic live">
        <VoiceRoomControl {...args} tone="live" label="Mute microphone">
          <Mic className="size-5" />
        </VoiceRoomControl>
      </ToneCell>
      <ToneCell caption="mic muted">
        <VoiceRoomControl
          {...args}
          tone="destructive"
          pressed
          label="Unmute microphone"
        >
          <MicOff className="size-5" />
        </VoiceRoomControl>
      </ToneCell>
      <ToneCell caption="speaker muted">
        <VoiceRoomControl
          {...args}
          tone="destructive"
          pressed
          label="Unmute assistant"
        >
          <VolumeX className="size-5" />
        </VoiceRoomControl>
      </ToneCell>
      <ToneCell caption="camera (engaged)">
        <VoiceRoomControl {...args} pressed label="Close camera">
          <CameraOff className="size-5" />
        </VoiceRoomControl>
      </ToneCell>
      <ToneCell caption="end">
        <VoiceRoomControl
          {...args}
          tone="destructive"
          label="End voice session"
        >
          <X className="size-5" strokeWidth={2.5} />
        </VoiceRoomControl>
      </ToneCell>
    </div>
  ),
};

/**
 * The row as it ships, at its own 16px gap: mute the mic, mute the assistant,
 * close the camera, end the session. Four 52px circles, the same four whether
 * or not the viewfinder is up, so nothing resizes under a reaching thumb when
 * the camera opens.
 */
export const CameraRow: Story = {
  render: (args) => (
    <div className="flex items-center justify-center gap-4">
      <VoiceRoomControl {...args} tone="live" label="Mute microphone">
        <Mic className="size-5" />
      </VoiceRoomControl>
      <VoiceRoomControl {...args} label="Mute assistant">
        <Volume2 className="size-5" />
      </VoiceRoomControl>
      <VoiceRoomControl {...args} pressed label="Close camera">
        <CameraOff className="size-5" />
      </VoiceRoomControl>
      <VoiceRoomControl {...args} tone="destructive" label="End voice session">
        <X className="size-5" strokeWidth={2.5} />
      </VoiceRoomControl>
    </div>
  ),
};
