import type { Meta, StoryObj } from "@storybook/react-vite";

import { makePreviewableImages } from "@/domains/chat/components/chat-attachments/attachment-fixtures";
import { CameraFrameGrid } from "@/domains/chat/components/chat-attachments/camera-frame-grid";
import type { DisplayMessage } from "@/domains/chat/types/types";

function frames(count: number): DisplayMessage[] {
  return makePreviewableImages(count).map((attachment, index) => ({
    id: `frame-${index}`,
    role: "user",
    textSegments: ["(camera frame)"],
    timestamp: new Date(2026, 8, 1, 14, 30, index * 5).getTime(),
    attachments: [attachment],
  }));
}

const meta: Meta<typeof CameraFrameGrid> = {
  title: "Chat/CameraFrameGrid",
  component: CameraFrameGrid,
  decorators: [
    (Story) => (
      <div className="max-w-2xl rounded-lg bg-[var(--surface-base)] p-4">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof CameraFrameGrid>;

export const FiveFrames: Story = { args: { frames: frames(5) } };
export const MixedPendingAndHydrated: Story = {
  args: {
    frames: frames(5).map((frame, index) =>
      index % 2 === 0 ? { ...frame, attachments: [] } : frame,
    ),
  },
};
export const LongRun: Story = { args: { frames: frames(120) } };
export const LongRunMobile: Story = {
  ...LongRun,
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
