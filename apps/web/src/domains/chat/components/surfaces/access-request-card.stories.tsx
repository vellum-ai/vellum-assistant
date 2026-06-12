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

function makeAccessRequestSurface(
  overrides: {
    displayName?: string;
    subtitle?: string;
    body?: string;
    metadata?: Array<{ label: string; value: string }>;
    requestId?: string;
  } = {},
): Surface {
  const requestId = overrides.requestId ?? "req-123";
  return {
    surfaceId: `access-request-${requestId}`,
    surfaceType: "card",
    title: "Access Request",
    data: {
      title: overrides.displayName ?? "Alice",
      subtitle: overrides.subtitle ?? "Requesting access to the assistant",
      body: overrides.body ?? "No additional context available.",
      metadata: overrides.metadata ?? [],
    },
    actions: [
      { id: `apr:${requestId}:approve_once`, label: "Approve", style: "primary" },
      { id: `apr:${requestId}:reject`, label: "Reject", style: "secondary" },
    ],
  };
}

export const NormalUser: Story = {
  name: "Normal workspace member",
  render: () => (
    <SurfaceRouter
      surface={makeAccessRequestSurface({
        displayName: "Alice",
        body: '> "Hey, can you help me set up my project environment?"',
        metadata: [
          { label: "Username", value: "@alice" },
          { label: "Source", value: "Slack — #general" },
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
      surface={makeAccessRequestSurface({
        displayName: "Bob (External)",
        body: [
          '> "I was referred by your team to get some help."',
          "",
          "⚠️ External Slack user (not in this workspace).",
          "",
          "[View message](https://slack.com/archives/C01ABC/p1700000000000100)",
        ].join("\n"),
        metadata: [
          { label: "Username", value: "@bob-external" },
          { label: "Source", value: "Slack — #partnerships" },
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
      surface={makeAccessRequestSurface({
        displayName: "Charlie",
        body: [
          '> "Need access to review the Q4 reports."',
          "",
          "⚠️ Guest / restricted account.",
        ].join("\n"),
        metadata: [
          { label: "Username", value: "@charlie-guest" },
          { label: "Source", value: "Slack — Direct message" },
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
      surface={makeAccessRequestSurface({
        displayName: "Dave",
        body: [
          '> "Hi again, I need access back to the assistant."',
          "",
          "⚠️ This user was previously revoked.",
          "",
          "[View message](https://slack.com/archives/C01ABC/p1700000000000200)",
        ].join("\n"),
        metadata: [
          { label: "Username", value: "@dave" },
          { label: "Source", value: "Slack — #engineering" },
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
      surface={makeAccessRequestSurface({
        displayName: "Eve",
        body: [
          '> "Please let me in."',
          "",
          "⚠️ This user was previously revoked.",
          "⚠️ External Slack user (not in this workspace).",
          "⚠️ Guest / restricted account.",
          "",
          "[View message](https://slack.com/archives/C01ABC/p1700000000000300)",
        ].join("\n"),
        metadata: [
          { label: "Username", value: "@eve-ext" },
          { label: "Source", value: "Slack — #general" },
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
      surface={makeAccessRequestSurface({
        displayName: "Frank",
        body: '> "Can I use the assistant?"',
        metadata: [
          { label: "Username", value: "@frank" },
          { label: "Source", value: "Slack — Direct message" },
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
      surface={makeAccessRequestSurface({
        displayName: "Someone",
      })}
      onAction={() => {}}
    />
  ),
};
