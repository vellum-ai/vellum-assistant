import type { Meta, StoryObj } from "@storybook/react-vite";

import type { Surface } from "@/domains/chat/types/types";

import { SurfaceRouter } from "./surface-router";

const meta: Meta = {
  title: "Chat/Surfaces/AccessRequestCard",
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <div className="max-w-[520px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

function accessRequestSurface(
  requestId: string,
  data: {
    title: string;
    subtitle: string;
    body: string;
    metadata?: Array<{ label: string; value: string }>;
  },
): Surface {
  return {
    surfaceId: `access-request-${requestId}`,
    surfaceType: "card",
    title: "Access Request",
    data,
    actions: [
      { id: `apr:${requestId}:approve_once`, label: "Approve", style: "primary" },
      { id: `apr:${requestId}:reject`, label: "Reject", style: "destructive" },
    ],
  };
}

export const NormalUser: Story = {
  name: "Normal workspace member",
  render: () => (
    <SurfaceRouter
      surface={accessRequestSurface("req-001", {
        title: "Alice",
        subtitle: "Requesting access to the assistant",
        body: [
          '> "Hey, can you help me set up my project environment?"',
          "[View message](https://slack.com/archives/C01GENERAL/p1700000000000100)",
        ].join("\n\n"),
        metadata: [
          { label: "Source", value: "Slack" },
          { label: "Channel", value: "#general" },
          { label: "Username", value: "@alice" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const ExternalUser: Story = {
  name: "External Slack user (is_stranger)",
  render: () => (
    <SurfaceRouter
      surface={accessRequestSurface("req-002", {
        title: "Bob (External)",
        subtitle: "Requesting access to the assistant",
        body: [
          '> "I was referred by your team to get some help."',
          "⚠️ External Slack user (not in this workspace).",
          "[View message](https://slack.com/archives/C01PARTNERS/p1700000000000100)",
        ].join("\n\n"),
        metadata: [
          { label: "Source", value: "Slack" },
          { label: "Channel", value: "#partners" },
          { label: "Username", value: "@bob-external" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const RestrictedUser: Story = {
  name: "Guest / restricted account",
  render: () => (
    <SurfaceRouter
      surface={accessRequestSurface("req-003", {
        title: "Charlie",
        subtitle: "Requesting access to the assistant",
        body: [
          '> "Need access to review the Q4 reports."',
          "⚠️ Guest / restricted account.",
        ].join("\n\n"),
        metadata: [
          { label: "Source", value: "Slack" },
          { label: "DM", value: "Direct message" },
          { label: "Username", value: "@charlie-guest" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const PreviouslyRevokedUser: Story = {
  name: "Previously revoked user",
  render: () => (
    <SurfaceRouter
      surface={accessRequestSurface("req-004", {
        title: "Dave",
        subtitle: "Requesting access to the assistant",
        body: [
          '> "Hi again, I need access back to the assistant."',
          "⚠️ This user was previously revoked.",
          "[View message](https://slack.com/archives/C01ENGINEERING/p1700000000000200)",
        ].join("\n\n"),
        metadata: [
          { label: "Source", value: "Slack" },
          { label: "Channel", value: "#engineering" },
          { label: "Username", value: "@dave" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const AllWarnings: Story = {
  name: "External + restricted + revoked (all warnings)",
  render: () => (
    <SurfaceRouter
      surface={accessRequestSurface("req-005", {
        title: "Eve",
        subtitle: "Requesting access to the assistant",
        body: [
          '> "Please let me in."',
          "⚠️ This user was previously revoked.",
          "⚠️ External Slack user (not in this workspace).",
          "⚠️ Guest / restricted account.",
          "[View message](https://slack.com/archives/C01GENERAL/p1700000000000300)",
        ].join("\n\n"),
        metadata: [
          { label: "Source", value: "Slack" },
          { label: "Channel", value: "#general" },
          { label: "Username", value: "@eve-ext" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const DirectMessage: Story = {
  name: "Direct message (no channel)",
  render: () => (
    <SurfaceRouter
      surface={accessRequestSurface("req-006", {
        title: "Frank",
        subtitle: "Requesting access to the assistant",
        body: '> "Can I use the assistant?"',
        metadata: [
          { label: "Source", value: "Slack" },
          { label: "DM", value: "Direct message" },
          { label: "Username", value: "@frank" },
        ],
      })}
      onAction={() => {}}
    />
  ),
};

export const MinimalInfo: Story = {
  name: "Minimal info (no preview, no metadata)",
  render: () => (
    <SurfaceRouter
      surface={accessRequestSurface("req-007", {
        title: "Unknown",
        subtitle: "Requesting access to the assistant",
        body: "No additional context available.",
      })}
      onAction={() => {}}
    />
  ),
};
