import type { Meta, StoryObj } from "@storybook/react-vite";

import { CompanionPopover } from "@/components/companion-popover";
import {
  COMPANION_POPOVER_INSET,
  COMPANION_POPOVER_WIDTH,
} from "@vellumai/ipc-contract";

/**
 * The popover beside the companion, at the width its window gives it, over a
 * desktop it floats above.
 */
const meta: Meta<typeof CompanionPopover> = {
  title: "Companion/Popover",
  component: CompanionPopover,
  args: { assistantName: "Ziggy" },
  decorators: [
    (Story) => (
      <div
        data-theme="dark"
        style={{
          width: COMPANION_POPOVER_WIDTH,
          padding: COMPANION_POPOVER_INSET,
          background:
            "linear-gradient(140deg, #cbd5e1 0%, #64748b 55%, #334155 100%)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;

/** An inline picture, so the story draws without reaching the network. */
const BRIDGE_IMAGE = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#9ec5e8"/><rect y="250" width="640" height="110" fill="#2f6f9f"/><rect x="150" y="60" width="18" height="220" fill="#c0362c"/><rect x="470" y="60" width="18" height="220" fill="#c0362c"/><rect y="228" width="640" height="14" fill="#c0362c"/><path d="M0 230 Q159 40 159 60 Q320 250 479 60 Q479 40 640 230" stroke="#c0362c" stroke-width="5" fill="none"/></svg>',
)}`;
type Story = StoryObj<typeof CompanionPopover>;

export const Approval: Story = {
  args: {
    popover: {
      kind: "approval",
      id: "req-1",
      title: "Listing the files in your Downloads folder",
      detail: "Runs a command on your Mac that reads your Downloads folder.",
    },
  },
};

export const PermissionRequest: Story = {
  args: {
    popover: {
      kind: "approval",
      id: "req-2",
      title: "Asking for Screen Recording",
      detail: "So I can see the window you want help with.",
      permission: "screen",
    },
  },
};

export const CardWithImageAndLink: Story = {
  args: {
    popover: {
      kind: "card",
      id: "surf-1",
      title: "Golden Gate Bridge",
      subtitle: "San Francisco",
      body: `![A red bridge over the water](${BRIDGE_IMAGE})\n\nOpened in 1937. [Plan a visit](https://example.com/visit)`,
      actions: [
        { id: "later", label: "Remind me later", style: "secondary" },
        { id: "save", label: "Save", style: "primary" },
      ],
    },
  },
};

export const SurfaceToOpen: Story = {
  args: {
    popover: {
      kind: "surface",
      id: "form-1",
      title: "Shipping address",
    },
  },
};
