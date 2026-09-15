import type { Meta, StoryObj } from "@storybook/react-vite";

import { CompanionPopover } from "@/components/companion-popover";
import { COMPANION_POPOVER_INSET } from "@vellumai/ipc-contract";

/**
 * The popover beside the companion, over a desktop it floats above: the short
 * form of a prompt, and the panel it opens into.
 */
const meta: Meta<typeof CompanionPopover> = {
  title: "Companion/Popover",
  component: CompanionPopover,
  args: { view: "row", accentHex: "#5eead4" },
  decorators: [
    (Story) => (
      <div
        data-theme="dark"
        style={{
          display: "inline-block",
          padding: COMPANION_POPOVER_INSET * 3,
          background:
            "radial-gradient(120% 90% at 20% 10%, #b3391d 0%, transparent 60%), linear-gradient(140deg, #8e2a14 0%, #6d1f10 55%, #4a150b 100%)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof CompanionPopover>;

/** An inline picture, so the story draws without reaching the network. */
const BRIDGE_IMAGE = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#9ec5e8"/><rect y="250" width="640" height="110" fill="#2f6f9f"/><rect x="150" y="60" width="18" height="220" fill="#c0362c"/><rect x="470" y="60" width="18" height="220" fill="#c0362c"/><rect y="228" width="640" height="14" fill="#c0362c"/><path d="M0 230 Q159 40 159 60 Q320 250 479 60 Q479 40 640 230" stroke="#c0362c" stroke-width="5" fill="none"/></svg>',
)}`;

const THREE = {
  kind: "approvals" as const,
  id: "req-1,req-2,req-3",
  items: [
    {
      id: "req-1",
      title: "Need your permission accessing the Downloads folder",
      detail: "",
    },
    { id: "req-2", title: "Open Safari to check the booking", detail: "" },
    { id: "req-3", title: "Send the confirmation email", detail: "" },
  ],
};

const SECRET = {
  kind: "secret" as const,
  id: "sec-1",
  service: "Booking.com",
  providerKey: "booking_com",
  detail: "To sign in and check the reservation you asked about.",
  label: "Password",
  placeholder: "Type your booking password",
};

export const SingleApproval: Story = {
  args: {
    popover: { ...THREE, id: "req-1", items: [THREE.items[0]] },
  },
};

/** An ask long enough to need a second line, which it gets rather than an ellipsis. */
export const LongApproval: Story = {
  args: {
    popover: {
      kind: "approvals",
      id: "req-9",
      items: [
        {
          id: "req-9",
          title:
            "Need your permission to read every file in your Downloads folder and move the invoices into Documents/Taxes/2026",
          detail: "",
        },
      ],
    },
  },
};

export const ApprovalsSummary: Story = {
  args: { popover: THREE },
};

export const ApprovalsReviewed: Story = {
  args: { popover: THREE, view: "expanded" },
};

export const CredentialRow: Story = {
  args: { popover: SECRET },
};

export const CredentialForm: Story = {
  args: { popover: SECRET, view: "expanded" },
};

export const CardWithImageAndLink: Story = {
  args: {
    view: "expanded",
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
    view: "expanded",
    popover: {
      kind: "surface",
      id: "form-1",
      title: "Shipping address",
    },
  },
};

export const MicrophonePicker: Story = {
  args: {
    view: "expanded",
    popover: {
      kind: "microphones",
      id: "microphones",
      options: [
        { id: "builtin", label: "MacBook Pro Microphone" },
        { id: "airpods", label: "AirPods Pro" },
        { id: "usb", label: "Shure MV7" },
      ],
      selected: "airpods",
      needsPermission: false,
    },
  },
};

export const VoicePicker: Story = {
  args: {
    view: "expanded",
    popover: {
      kind: "voices",
      id: "voices",
      groups: [
        {
          accent: "American",
          voices: [
            { id: "v1", label: "Warm, clear", sampleUrl: "", isDefault: true },
            { id: "v2", label: "Bright, upbeat", sampleUrl: "", isDefault: false },
          ],
        },
        {
          accent: "British",
          voices: [
            { id: "v3", label: "Calm, measured", sampleUrl: "", isDefault: false },
          ],
        },
      ],
      selected: "v2",
    },
  },
};
