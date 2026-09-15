import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";

import {
  CompanionPopover,
  CompanionPromptRow,
  type CompanionPromptContent,
} from "@/components/companion-popover";
import { CompanionSurface } from "@/components/companion-surface";
import {
  COMPANION_BASE_AVATAR_BOX,
  companionNearEdgeFor,
  type CompanionPopover as CompanionPopoverContent,
  type CompanionPopoverView,
  type VoiceActivityState,
} from "@vellumai/ipc-contract";

/**
 * The popover and the call's bar together, the way a user on a call sees
 * them: a prompt's short form joined to the bar as a row of its own, or the
 * whole popover standing just above the bar in its own window.
 *
 * The bar is the real surface in a stand-in of its canvas. The popover above
 * it is drawn where main places its window: centred on the bar and clear of
 * it by the gap main keeps.
 */
const meta: Meta = {
  title: "Companion/Popover with call",
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj;

const CALL: VoiceActivityState = {
  phase: "listening",
  label: "Listening",
  accentHex: "#5eead4",
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
  assistantName: "Ziggy",
};

const WORKING_CALL: VoiceActivityState = {
  ...CALL,
  phase: "thinking",
  label: "Thinking…",
  detail: "Running a command",
};

const CHARACTER = { bodyShape: "burst", eyeStyle: "curious", color: "teal" };

const ONE: CompanionPromptContent = {
  kind: "approvals",
  id: "req-1",
  items: [{ id: "req-1", title: "Listing files on your desktop", detail: "" }],
};

const THREE: CompanionPromptContent = {
  kind: "approvals",
  id: "req-1,req-2,req-3",
  items: [
    { id: "req-1", title: "Listing files on your desktop", detail: "" },
    { id: "req-2", title: "Open Safari to check the booking", detail: "" },
    { id: "req-3", title: "Send the confirmation email", detail: "" },
  ],
};

const SECRET: CompanionPromptContent = {
  kind: "secret",
  id: "sec-1",
  service: "Booking.com",
  providerKey: "booking_com",
  detail: "To sign in and check the reservation you asked about.",
  label: "Password",
  placeholder: "Type your booking password",
};

/** An inline picture, so the story draws without reaching the network. */
const BRIDGE_IMAGE = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#9ec5e8"/><rect y="250" width="640" height="110" fill="#2f6f9f"/><rect x="150" y="60" width="18" height="220" fill="#c0362c"/><rect x="470" y="60" width="18" height="220" fill="#c0362c"/><rect y="228" width="640" height="14" fill="#c0362c"/><path d="M0 230 Q159 40 159 60 Q320 250 479 60 Q479 40 640 230" stroke="#c0362c" stroke-width="5" fill="none"/></svg>',
)}`;

const CARD: CompanionPopoverContent = {
  kind: "card",
  id: "surf-1",
  title: "Golden Gate Bridge",
  subtitle: "San Francisco",
  body: `![A red bridge over the water](${BRIDGE_IMAGE})\n\nOpened in 1937. [Plan a visit](https://example.com/visit)`,
  actions: [
    { id: "later", label: "Remind me later", style: "secondary" },
    { id: "save", label: "Save", style: "primary" },
  ],
};

/** The canvas the bar is drawn in, and how far its centre sits off the bottom. */
const STAGE_WIDTH = 900;
const STAGE_HEIGHT = 720;
const BAR_CENTRE_FROM_BOTTOM = companionNearEdgeFor(
  COMPANION_BASE_AVATAR_BOX,
  COMPANION_BASE_AVATAR_BOX,
);
/** Half the bar's height, and the gap main keeps between bar and popover. */
const BAR_HALF = 22;
const POPOVER_GAP = 8;

function Stage({
  call = CALL,
  prompt,
  promptsDeferred,
  popover,
}: {
  call?: VoiceActivityState;
  prompt?: ReactNode;
  promptsDeferred?: number;
  popover?: ReactNode;
}) {
  return (
    <div
      data-theme="dark"
      className="relative overflow-hidden rounded-xl"
      style={{
        width: STAGE_WIDTH,
        height: STAGE_HEIGHT,
        background:
          "radial-gradient(120% 90% at 20% 10%, #b3391d 0%, transparent 60%), linear-gradient(140deg, #8e2a14 0%, #6d1f10 55%, #4a150b 100%)",
      }}
    >
      {popover !== undefined ? (
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            bottom: BAR_CENTRE_FROM_BOTTOM + BAR_HALF + POPOVER_GAP,
          }}
        >
          {popover}
        </div>
      ) : null}
      <div className="absolute inset-0">
        <CompanionSurface
          phase="call"
          call={call}
          assistantName="Ziggy"
          accentHex={call.accentHex}
          character={CHARACTER}
          prompt={prompt}
          promptsDeferred={promptsDeferred}
        />
      </div>
    </div>
  );
}

const whole = (
  popover: CompanionPopoverContent,
  view: CompanionPopoverView = "expanded",
) => (
  <CompanionPopover popover={popover} view={view} accentHex={CALL.accentHex} />
);

/** The call alone, for comparison. */
export const CallBar: Story = {
  render: () => <Stage />,
};

/** One approval, asked on a row joined to the bar. */
export const SingleApprovalOnTheBar: Story = {
  render: () => (
    <Stage call={WORKING_CALL} prompt={<CompanionPromptRow popover={ONE} />} />
  ),
};

/** Several approvals, summed up on a row joined to the bar. */
export const ApprovalsOnTheBar: Story = {
  render: () => <Stage prompt={<CompanionPromptRow popover={THREE} />} />,
};

/** Reviewed: the numbered list in its own window above the bar. */
export const ApprovalsReviewedAboveTheBar: Story = {
  render: () => <Stage popover={whole(THREE)} />,
};

/** Put off: counted on the bar, a press away. */
export const ApprovalsPutOff: Story = {
  render: () => <Stage promptsDeferred={3} />,
};

/** A credential, named on a row joined to the bar. */
export const CredentialOnTheBar: Story = {
  render: () => <Stage prompt={<CompanionPromptRow popover={SECRET} />} />,
};

/** Entered: the form in its own window above the bar. */
export const CredentialFormAboveTheBar: Story = {
  render: () => <Stage popover={whole(SECRET)} />,
};

/**
 * A text card with a list, in a warm accent, over a bar lit in the same
 * colour: the panel's spacing and wash against the bar's own material.
 */
export const ResearchCardAboveTheBar: Story = {
  render: () => (
    <Stage
      call={{
        ...CALL,
        phase: "speaking",
        label: "Speaking…",
        accentHex: "#E9642F",
      }}
      popover={
        <CompanionPopover
          view="expanded"
          accentHex="#E9642F"
          popover={{
            kind: "card",
            id: "surf-2",
            title: "Blue Whales: Research Roundup",
            subtitle: "Journal-level findings, with sources",
            body: "A couple of headliners from the recent literature:\n\n- **Heartbeat study:** PNAS, 2019\n- **New population:** Endangered Species Research, 2020",
            actions: [],
          }}
        />
      }
    />
  ),
};

/** A card with an image and a link, above the bar. */
export const CardAboveTheBar: Story = {
  render: () => <Stage popover={whole(CARD)} />,
};
